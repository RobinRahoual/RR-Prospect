// Déploie le serveur (API + PostgreSQL) sur le NAS par SSH : aucune ligne de commande côté utilisateur.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("ssh2");
const { HintError } = require("./errors");

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function connect({ host, port = 22, username, password }) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", (e) => {
      const m = /authentication/i.test(e.message)
        ? new HintError("Identifiants SSH refusés.", "Vérifie l'utilisateur et le mot de passe du NAS (ceux de ta session Linux, pas CasaOS).")
        : new HintError(`Connexion SSH impossible : ${e.message}`, "Vérifie l'adresse IP, que le NAS est allumé et que SSH est actif (port 22).");
      reject(m);
    });
    c.connect({ host, port, username, password, readyTimeout: 15000, keepaliveInterval: 10000 });
  });
}

function exec(conn, cmd, onLine) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      const feed = (d) => {
        const s = d.toString();
        out += s;
        if (onLine) s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).forEach(onLine);
      };
      stream.on("data", feed);
      stream.stderr.on("data", feed);
      stream.on("close", (code) => resolve({ code, out }));
    });
  });
}

const openSftp = (conn) => new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
const putFile = (s, remote, buf) => new Promise((res, rej) => s.writeFile(remote, buf, (e) => (e ? rej(e) : res())));

function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name === "tests" || e.name.endsWith(".pyc")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return acc;
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function deploy({ host, username, password, baseDir, gemini, log }) {
  const conn = await connect({ host, username, password });
  try {
    const home = (await exec(conn, "echo $HOME")).out.trim();
    const dir = `${home}/rr-prospect`;

    // Docker accessible directement, sinon via sudo
    let sudo = false;
    let r = await exec(conn, "docker version --format '{{.Server.Version}}'");
    if (r.code !== 0) {
      r = await exec(conn, `echo ${q(password)} | sudo -S -p '' docker version --format '{{.Server.Version}}'`);
      sudo = r.code === 0;
    }
    if (r.code !== 0) {
      throw new HintError(
        "Docker est introuvable ou inaccessible sur le NAS.",
        "Vérifie que Docker tourne (CasaOS l'installe d'origine) et que cet utilisateur peut l'utiliser."
      );
    }
    log(`Docker ${r.out.trim().split("\n").pop()} détecté${sudo ? " (via sudo)" : ""}`);
    const S = (c) => (sudo ? `echo ${q(password)} | sudo -S -p '' ${c}` : c);

    const composeCmd = (await exec(conn, S("docker compose version"))).code === 0 ? "docker compose" : "docker-compose";

    // Fichiers de l'application
    log("Envoi des fichiers sur le NAS…");
    const files = ["docker-compose.yml", ...walk(path.join(baseDir, "api")).map((f) => `api/${f}`)];
    const dirs = [...new Set(files.map((f) => path.posix.dirname(f)).filter((d) => d !== "."))];
    await exec(conn, `mkdir -p ${q(dir)} ${dirs.map((d) => q(`${dir}/${d}`)).join(" ")}`);
    const sftp = await openSftp(conn);
    for (const f of files) await putFile(sftp, `${dir}/${f}`, fs.readFileSync(path.join(baseDir, f)));

    // .env : on conserve les secrets d'une installation précédente
    const prev = parseEnv((await exec(conn, `cat ${q(dir + "/.env")} 2>/dev/null`)).out);
    const pg = prev.POSTGRES_PASSWORD || crypto.randomBytes(18).toString("hex");
    const token = prev.APP_TOKEN || crypto.randomBytes(24).toString("hex");
    const env = [
      `POSTGRES_PASSWORD=${pg}`,
      `APP_TOKEN=${token}`,
      `GEMINI_API_KEY=${gemini.key}`,
      `GEMINI_MODEL=${gemini.model}`,
      `GEMINI_FALLBACK_MODEL=${gemini.fallback}`,
      "GEMINI_GROUNDING=false",
      "CORS_ORIGINS=",
      "",
    ].join("\n");
    await putFile(sftp, `${dir}/.env`, Buffer.from(env));
    await exec(conn, `chmod 600 ${q(dir + "/.env")}`);

    log("Construction et démarrage des conteneurs (2 à 5 min la première fois)…");
    const up = await exec(conn, S(`sh -c ${q(`cd ${dir} && ${composeCmd} up -d --build`)}`), (l) => {
      if (/Building|Pulling|Started|Running|Created|exporting|DONE|error/i.test(l)) log(l.slice(0, 140));
    });
    if (up.code !== 0) {
      throw new HintError("Le démarrage Docker a échoué.", up.out.split("\n").slice(-6).join("\n"));
    }

    // Attente de l'API depuis le PC (valide aussi le réseau et le port 8000)
    const url = `http://${host}:8000`;
    log("Attente de l'API…");
    for (let i = 0; i < 60; i++) {
      try {
        const h = await fetch(`${url}/api/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (h.ok) return { appUrl: url, token };
      } catch {
        /* pas encore prêt */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const logs = (await exec(conn, S(`sh -c ${q(`cd ${dir} && ${composeCmd} logs --tail 15 api`)}`))).out;
    throw new HintError("Le serveur ne répond pas sur le port 8000 depuis ce PC.", logs.slice(-600));
  } finally {
    conn.end();
  }
}

module.exports = { deploy };
