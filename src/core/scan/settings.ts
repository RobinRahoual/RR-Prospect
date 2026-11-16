export interface ScanCategory {
  id: string;
  label: string;
  /** Filtres OpenStreetMap : clé + valeurs possibles */
  tags: { key: string; values: string[] }[];
}

export const SCAN_CATEGORIES: ScanCategory[] = [
  { id: "bars", label: "Bars & pubs", tags: [{ key: "amenity", values: ["bar", "pub"] }] },
  { id: "clubs", label: "Clubs & discothèques", tags: [{ key: "amenity", values: ["nightclub"] }] },
  { id: "restaurants", label: "Restaurants", tags: [{ key: "amenity", values: ["restaurant"] }] },
  { id: "cafes", label: "Cafés & salons de thé", tags: [{ key: "amenity", values: ["cafe"] }] },
  { id: "venues", label: "Salles de spectacle & concert", tags: [{ key: "amenity", values: ["theatre", "music_venue", "arts_centre", "cinema"] }] },
  { id: "hotels", label: "Hôtels", tags: [{ key: "tourism", values: ["hotel", "guest_house"] }] },
  { id: "agencies", label: "Agences (pub, marketing, événementiel)", tags: [{ key: "office", values: ["advertising_agency", "marketing", "event_organizer"] }] },
  { id: "beauty", label: "Coiffeurs & instituts", tags: [{ key: "shop", values: ["hairdresser", "beauty"] }] },
  { id: "sport", label: "Salles de sport", tags: [{ key: "leisure", values: ["fitness_centre", "sports_centre"] }] },
];

export interface ScanSettings {
  placeLabel: string;
  lat: number;
  lon: number;
  radiusKm: number;
  categories: string[];
  /** Nombre maximum de leads ajoutés par scan (les plus prometteurs d'abord) */
  maxResults: number;
}

export const DEFAULT_SCAN: ScanSettings = {
  placeLabel: "Dijon",
  lat: 47.322,
  lon: 5.0415,
  radiusKm: 15,
  categories: ["bars", "clubs", "restaurants", "venues", "agencies"],
  maxResults: 100,
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
  };
}
