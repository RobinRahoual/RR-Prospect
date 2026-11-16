export interface ScanCategory {
  id: string;
  label: string;
  /** Filtres OpenStreetMap : clé + valeurs possibles */
  tags: { key: string; values: string[] }[];
  /** Codes NAF/APE (API Recherche d'entreprises) */
  naf: string[];
}

export const SCAN_CATEGORIES: ScanCategory[] = [
  { id: "bars", label: "Bars & pubs", tags: [{ key: "amenity", values: ["bar", "pub"] }], naf: ["56.30Z"] },
  { id: "clubs", label: "Clubs & discothèques", tags: [{ key: "amenity", values: ["nightclub"] }], naf: ["56.30Z"] },
  { id: "restaurants", label: "Restaurants", tags: [{ key: "amenity", values: ["restaurant"] }], naf: ["56.10A", "56.10B", "56.10C"] },
  { id: "cafes", label: "Cafés & salons de thé", tags: [{ key: "amenity", values: ["cafe"] }], naf: ["56.30Z"] },
  { id: "venues", label: "Salles de spectacle & concert", tags: [{ key: "amenity", values: ["theatre", "music_venue", "arts_centre", "cinema"] }], naf: ["90.01Z", "90.02Z", "90.04Z", "59.14Z"] },
  { id: "hotels", label: "Hôtels", tags: [{ key: "tourism", values: ["hotel", "guest_house"] }], naf: ["55.10Z", "55.20Z"] },
  { id: "agencies", label: "Agences (pub, marketing, événementiel)", tags: [{ key: "office", values: ["advertising_agency", "marketing", "event_organizer"] }], naf: ["73.11Z", "82.30Z"] },
  { id: "beauty", label: "Coiffeurs & instituts", tags: [{ key: "shop", values: ["hairdresser", "beauty"] }], naf: ["96.02A", "96.02B"] },
  { id: "sport", label: "Salles de sport", tags: [{ key: "leisure", values: ["fitness_centre", "sports_centre"] }], naf: ["93.13Z"] },
];

export interface ScanSettings {
  placeLabel: string;
  lat: number;
  lon: number;
  radiusKm: number;
  categories: string[];
  /** Nombre maximum de leads ajoutés par scan (les plus prometteurs d'abord) */
  maxResults: number;
  sources: { osm: boolean; sirene: boolean; openagenda: boolean };
  /** SIRENE : on ne garde que les entreprises créées depuis N mois */
  sireneMonths: number;
  /** OpenAgenda : identifiants des agendas à lire (la clé API est stockée à part) */
  agendaUids: string[];
}

export const DEFAULT_SCAN: ScanSettings = {
  placeLabel: "Dijon",
  lat: 47.322,
  lon: 5.0415,
  radiusKm: 15,
  categories: ["bars", "clubs", "restaurants", "venues", "agencies"],
  maxResults: 100,
  sources: { osm: true, sirene: true, openagenda: false },
  sireneMonths: 18,
  agendaUids: [],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Valide et borne les réglages venant de l'interface. */
export function normalizeScan(input: Partial<ScanSettings> | undefined, base: ScanSettings = DEFAULT_SCAN): ScanSettings {
  const s = { ...base, ...(input ?? {}) };
  const known = new Set(SCAN_CATEGORIES.map((c) => c.id));
  const lat = Number(s.lat);
  const lon = Number(s.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Coordonnées invalides");
  const categories = [...new Set((s.categories ?? []).filter((c) => known.has(c)))];
  if (!categories.length) throw new Error("Choisis au moins une catégorie");
  return {
    placeLabel: String(s.placeLabel || "").trim().slice(0, 80) || "Zone personnalisée",
    lat,
    lon,
    radiusKm: clamp(Number(s.radiusKm) || base.radiusKm, 1, 50),
    categories,
    maxResults: Math.round(clamp(Number(s.maxResults) || base.maxResults, 1, 500)),
    sources: { ...base.sources, ...(s.sources ?? {}) },
    sireneMonths: Math.round(clamp(Number(s.sireneMonths) || base.sireneMonths, 1, 120)),
    agendaUids: [...new Set((s.agendaUids ?? []).map((x) => String(x).trim()).filter((x) => /^\d{3,12}$/.test(x)))].slice(0, 20),
  };
}
