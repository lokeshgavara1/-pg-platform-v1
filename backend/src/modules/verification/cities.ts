import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const citySchema = z.object({
  code: z.string(),
  name: z.string(),
  authority: z.string(),
  verified: z.boolean(),
  note: z.string(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), source: z.string() })).min(1),
});
export type CityConfig = z.infer<typeof citySchema>;

const dir = fileURLToPath(new URL('../../../config/cities/', import.meta.url));
let cache: Map<string, CityConfig> | null = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const cfg = citySchema.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
    cache.set(cfg.code, cfg);
  }
  return cache;
}

export const listCityCodes = () => [...load().keys()];
export const listCities = () => [...load().values()];
export const getCity = (code: string) => load().get(code);
