# Wilde Wegwijzer

Mobiele kaart voor Wilde Weide, met satellietbeeld, POI's, privé deel-pins, publieke pins en een simpele admin-editor.

## Lokaal draaien

Maak een lokale env-file op basis van het voorbeeld:

```sh
cp .env.example .env
```

Vul in `.env` een eigen `ADMIN_PASSWORD` en een lange random `SESSION_SECRET` in. Deze file staat in `.gitignore` en hoort niet in GitHub.

Start daarna de server:

```sh
python3 server.py
```

Open:

- app: `http://127.0.0.1:8080/`
- admin: `http://127.0.0.1:8080/admin`

Als de database nog leeg is, seedt de server automatisch vanuit `seed/wilde-weide-2026.json`.

## Seed en database

De live SQLite database wordt niet committed. De reproduceerbare startdata staat wel in GitHub:

```sh
seed/wilde-weide-2026.json
```

Een verse database expliciet opbouwen:

```sh
python3 tools/seed_db.py --db ./data/wildewegwijzer.sqlite --seed seed/wilde-weide-2026.json --reset
```

Voor een nieuwe festivalvariant, zoals Wildeburg, maak je een nieuwe seedfile met een eigen `festival.id` en start je een database met die seed. De live DB blijft daarna de stateful bron.

## Docker

Build:

```sh
docker build -t wildeweide-map:latest .
```

Run:

```sh
docker run -d \
  --name wildeweide-map \
  --restart unless-stopped \
  -p 8080:8080 \
  -v wildeweide_map_data:/data \
  -e DATABASE_PATH=/data/wildewegwijzer.sqlite \
  -e SEED_PATH=/app/seed/wilde-weide-2026.json \
  -e ADMIN_PASSWORD='choose-a-password-outside-git' \
  -e SESSION_SECRET='replace-with-a-long-random-string' \
  wildeweide-map:latest
```

## Anton deploy-notities

De container luistert intern op poort `8080`. Caddy moet dus reverse proxyen naar:

```txt
wildeweide-map:8080
```

Gebruik op Anton een Docker volume voor `/data`, en zet secrets via env vars of een server-side env-file. Commit nooit `.env`, `*.sqlite` of een echt wachtwoord.

## API

- `GET /api/bootstrap`: kaartmetadata, features en publieke pins.
- `POST /api/public-pins`: publieke pin toevoegen, direct zichtbaar.
- `POST /api/admin/login`: admin-cookie zetten.
- `GET/POST/PATCH/DELETE /api/admin/features`: kaartobjecten beheren.
- `GET/PATCH/DELETE /api/admin/public-pins/:id`: publieke pins modereren.
