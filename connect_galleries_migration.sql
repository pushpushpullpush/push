-- Neue Tabelle für die "connect"-Galerien (siehe [c] auf main).
-- Jede Zeile ist eine vom User zusammengestellte Auswahl von >=2 Bildern.
-- "images" speichert einen Schnappschuss der ausgewählten Bilder (id, url,
-- natural_width, natural_height) direkt als JSON -- kein Join nötig, um sie
-- anzuzeigen oder ein zufälliges Vorschaubild auf main zu wählen.
create table if not exists public.connect_galleries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  images jsonb not null
);

alter table public.connect_galleries enable row level security;

-- Gleiche Offenheit wie die "images"-Tabelle: kein Login nötig, um zu lesen
-- oder eine neue connect-Galerie anzulegen. Falls eure "images"-Tabelle
-- andere/zusätzliche Policies hat (z.B. Rate-Limiting), gerne entsprechend
-- anpassen.
create policy "Public read access"
  on public.connect_galleries for select
  using (true);

create policy "Public insert access"
  on public.connect_galleries for insert
  with check (true);
