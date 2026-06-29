import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_FESTIVAL_ID = "wilde-weide-2026"
MAX_PUBLIC_PIN_LABEL = 140


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def connect_database(database_path):
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_database(database_path):
    with connect_database(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS festivals (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS features (
              id TEXT PRIMARY KEY,
              festival_id TEXT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
              feature_type TEXT NOT NULL CHECK(feature_type IN ('stage', 'area')),
              title TEXT NOT NULL,
              text TEXT NOT NULL DEFAULT '',
              map_kind TEXT NOT NULL CHECK(map_kind IN ('stage', 'camping', 'facility', 'info', 'dim')),
              display_kind TEXT NOT NULL CHECK(display_kind IN ('point', 'area')),
              style_category TEXT NOT NULL DEFAULT 'side',
              lat REAL,
              lon REAL,
              pixel_x REAL,
              pixel_y REAL,
              geometry_json TEXT,
              pixel_points_json TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              is_dim INTEGER NOT NULL DEFAULT 0,
              is_visible INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS public_pins (
              id TEXT PRIMARY KEY,
              festival_id TEXT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
              x REAL NOT NULL,
              y REAL NOT NULL,
              label TEXT NOT NULL DEFAULT '',
              is_visible INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_features_festival_sort
              ON features(festival_id, is_visible, sort_order);

            CREATE INDEX IF NOT EXISTS idx_public_pins_festival_visible
              ON public_pins(festival_id, is_visible, created_at);
            """
        )


def database_has_features(database_path, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS total FROM features WHERE festival_id = ?",
            (festival_id,),
        ).fetchone()
        return bool(row and row["total"])


def seed_database(database_path, seed_path, reset=False, only_if_empty=False):
    init_database(database_path)
    seed = json.loads(Path(seed_path).read_text(encoding="utf-8"))
    festival = seed.get("festival") or {}
    festival_id = festival.get("id") or DEFAULT_FESTIVAL_ID

    with connect_database(database_path) as connection:
        if only_if_empty:
            row = connection.execute(
                "SELECT COUNT(*) AS total FROM features WHERE festival_id = ?",
                (festival_id,),
            ).fetchone()
            if row and row["total"]:
                return False

        if reset:
            connection.execute("DELETE FROM public_pins WHERE festival_id = ?", (festival_id,))
            connection.execute("DELETE FROM features WHERE festival_id = ?", (festival_id,))
            connection.execute("DELETE FROM festivals WHERE id = ?", (festival_id,))

        now = utc_now()
        connection.execute(
            """
            INSERT INTO festivals (id, name, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              metadata_json = excluded.metadata_json,
              updated_at = excluded.updated_at
            """,
            (
                festival_id,
                festival.get("name") or "Wilde Weide 2026",
                json.dumps(seed.get("metadata") or {}, separators=(",", ":")),
                now,
                now,
            ),
        )

        for index, feature in enumerate(seed.get("features") or []):
            upsert_feature(connection, normalize_feature_payload(feature, index, festival_id))

        return True


def bootstrap_payload(database_path, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        festival = connection.execute(
            "SELECT * FROM festivals WHERE id = ?",
            (festival_id,),
        ).fetchone()
        if not festival:
            return {
                "festival": {"id": festival_id, "name": ""},
                "metadata": {},
                "stages": empty_feature_collection("wilde-weide-stages"),
                "areas": empty_feature_collection("wilde-weide-areas"),
                "publicPins": [],
            }

        rows = connection.execute(
            """
            SELECT * FROM features
            WHERE festival_id = ? AND is_visible = 1
            ORDER BY sort_order ASC, created_at ASC
            """,
            (festival_id,),
        ).fetchall()
        pins = connection.execute(
            """
            SELECT * FROM public_pins
            WHERE festival_id = ? AND is_visible = 1
            ORDER BY created_at ASC
            """,
            (festival_id,),
        ).fetchall()

        stages = [row_to_geojson_feature(row) for row in rows if row["feature_type"] == "stage"]
        areas = [row_to_geojson_feature(row) for row in rows if row["feature_type"] == "area"]

        return {
            "festival": {"id": festival["id"], "name": festival["name"]},
            "metadata": json.loads(festival["metadata_json"]),
            "stages": {
                "type": "FeatureCollection",
                "name": "wilde-weide-stages",
                "features": stages,
            },
            "areas": {
                "type": "FeatureCollection",
                "name": "wilde-weide-areas",
                "features": areas,
            },
            "publicPins": [public_pin_payload(pin) for pin in pins],
        }


def admin_features(database_path, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT * FROM features
            WHERE festival_id = ?
            ORDER BY sort_order ASC, created_at ASC
            """,
            (festival_id,),
        ).fetchall()
        return [admin_feature_payload(row) for row in rows]


def create_admin_feature(database_path, payload, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        feature = normalize_feature_payload(payload, None, festival_id)
        upsert_feature(connection, feature)
        row = connection.execute("SELECT * FROM features WHERE id = ?", (feature["id"],)).fetchone()
        return admin_feature_payload(row)


def patch_admin_feature(database_path, feature_id, payload, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        current = connection.execute(
            "SELECT * FROM features WHERE id = ? AND festival_id = ?",
            (feature_id, festival_id),
        ).fetchone()
        if not current:
            return None

        merged = admin_feature_payload(current)
        merged.update(payload or {})
        merged["id"] = feature_id
        feature = normalize_feature_payload(merged, merged.get("sortOrder"), festival_id)
        upsert_feature(connection, feature)
        row = connection.execute("SELECT * FROM features WHERE id = ?", (feature_id,)).fetchone()
        return admin_feature_payload(row)


def delete_admin_feature(database_path, feature_id, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        cursor = connection.execute(
            "DELETE FROM features WHERE id = ? AND festival_id = ?",
            (feature_id, festival_id),
        )
        return cursor.rowcount > 0


def admin_public_pins(database_path, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        rows = connection.execute(
            """
            SELECT * FROM public_pins
            WHERE festival_id = ?
            ORDER BY created_at DESC
            """,
            (festival_id,),
        ).fetchall()
        return [public_pin_payload(row) for row in rows]


def create_public_pin(database_path, payload, festival_id=DEFAULT_FESTIVAL_ID):
    x = as_finite_float(payload.get("x"), "x")
    y = as_finite_float(payload.get("y"), "y")
    label = clean_text(payload.get("label") or payload.get("text") or "", MAX_PUBLIC_PIN_LABEL)
    now = utc_now()
    pin_id = payload.get("id") or str(uuid.uuid4())

    with connect_database(database_path) as connection:
        connection.execute(
            """
            INSERT INTO public_pins (id, festival_id, x, y, label, is_visible, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (pin_id, festival_id, x, y, label, now, now),
        )
        row = connection.execute("SELECT * FROM public_pins WHERE id = ?", (pin_id,)).fetchone()
        return public_pin_payload(row)


def patch_public_pin(database_path, pin_id, payload, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        current = connection.execute(
            "SELECT * FROM public_pins WHERE id = ? AND festival_id = ?",
            (pin_id, festival_id),
        ).fetchone()
        if not current:
            return None

        x = as_finite_float(payload.get("x", current["x"]), "x")
        y = as_finite_float(payload.get("y", current["y"]), "y")
        label = clean_text(payload.get("label", current["label"]), MAX_PUBLIC_PIN_LABEL)
        is_visible = 1 if bool(payload.get("isVisible", current["is_visible"])) else 0
        connection.execute(
            """
            UPDATE public_pins
            SET x = ?, y = ?, label = ?, is_visible = ?, updated_at = ?
            WHERE id = ? AND festival_id = ?
            """,
            (x, y, label, is_visible, utc_now(), pin_id, festival_id),
        )
        row = connection.execute("SELECT * FROM public_pins WHERE id = ?", (pin_id,)).fetchone()
        return public_pin_payload(row)


def delete_public_pin(database_path, pin_id, festival_id=DEFAULT_FESTIVAL_ID):
    with connect_database(database_path) as connection:
        cursor = connection.execute(
            "DELETE FROM public_pins WHERE id = ? AND festival_id = ?",
            (pin_id, festival_id),
        )
        return cursor.rowcount > 0


def empty_feature_collection(name):
    return {"type": "FeatureCollection", "name": name, "features": []}


def upsert_feature(connection, feature):
    now = utc_now()
    created_at = feature.get("createdAt") or now
    connection.execute(
        """
        INSERT INTO features (
          id, festival_id, feature_type, title, text, map_kind, display_kind, style_category,
          lat, lon, pixel_x, pixel_y, geometry_json, pixel_points_json,
          sort_order, is_dim, is_visible, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          festival_id = excluded.festival_id,
          feature_type = excluded.feature_type,
          title = excluded.title,
          text = excluded.text,
          map_kind = excluded.map_kind,
          display_kind = excluded.display_kind,
          style_category = excluded.style_category,
          lat = excluded.lat,
          lon = excluded.lon,
          pixel_x = excluded.pixel_x,
          pixel_y = excluded.pixel_y,
          geometry_json = excluded.geometry_json,
          pixel_points_json = excluded.pixel_points_json,
          sort_order = excluded.sort_order,
          is_dim = excluded.is_dim,
          is_visible = excluded.is_visible,
          updated_at = excluded.updated_at
        """,
        (
            feature["id"],
            feature["festivalId"],
            feature["featureType"],
            feature["title"],
            feature["text"],
            feature["mapKind"],
            feature["displayKind"],
            feature["styleCategory"],
            feature.get("lat"),
            feature.get("lon"),
            feature.get("pixelX"),
            feature.get("pixelY"),
            json_or_none(feature.get("geometry")),
            json_or_none(feature.get("pixelPoints")),
            int(feature.get("sortOrder") or 0),
            1 if feature.get("isDim") else 0,
            1 if feature.get("isVisible", True) else 0,
            created_at,
            now,
        ),
    )


def normalize_feature_payload(payload, sort_order=None, festival_id=DEFAULT_FESTIVAL_ID):
    props = payload.get("properties") or {}
    geometry = payload.get("geometry")
    feature_type = payload.get("featureType") or props.get("featureType") or props.get("kind") or "area"
    feature_type = feature_type if feature_type in ("stage", "area") else "area"
    title = clean_text(payload.get("title") or props.get("title") or props.get("name") or "Nieuwe plek", 160)
    text = clean_text(payload.get("text") or props.get("text") or props.get("notes") or title, 500)
    map_kind = payload.get("mapKind") or props.get("mapKind") or ("stage" if feature_type == "stage" else "facility")
    if map_kind not in ("stage", "camping", "facility", "info", "dim"):
        map_kind = "facility"
    display_kind = payload.get("displayKind") or props.get("displayKind") or ("point" if feature_type == "stage" else "area")
    if display_kind not in ("point", "area"):
        display_kind = "area"
    style_category = clean_text(payload.get("styleCategory") or props.get("styleCategory") or map_kind, 40)
    is_dim = bool(payload.get("isDim", props.get("isDim", map_kind == "dim")))
    is_visible = bool(payload.get("isVisible", props.get("isVisible", True)))

    pixel_points = payload.get("pixelPoints", props.get("pixelPoints"))
    if isinstance(pixel_points, str):
        pixel_points = json.loads(pixel_points or "[]")
    pixel_points = normalize_pixel_points(pixel_points)

    pixel_x = payload.get("pixelX", props.get("pixelX"))
    pixel_y = payload.get("pixelY", props.get("pixelY"))
    if pixel_x is None and pixel_points:
        pixel_x = sum(point["x"] for point in pixel_points) / len(pixel_points)
    if pixel_y is None and pixel_points:
        pixel_y = sum(point["y"] for point in pixel_points) / len(pixel_points)

    lon = payload.get("lon", props.get("lon"))
    lat = payload.get("lat", props.get("lat"))
    if geometry and geometry.get("type") == "Point":
        coords = geometry.get("coordinates") or []
        if len(coords) >= 2:
            lon = coords[0]
            lat = coords[1]

    if not geometry and payload.get("geometryJson"):
        geometry = json.loads(payload["geometryJson"])

    return {
        "id": clean_text(payload.get("id") or props.get("id") or str(uuid.uuid4()), 80),
        "festivalId": payload.get("festivalId") or props.get("festivalId") or festival_id,
        "featureType": feature_type,
        "title": title,
        "text": text,
        "mapKind": "dim" if is_dim else map_kind,
        "displayKind": display_kind,
        "styleCategory": "dim" if is_dim else style_category,
        "lat": optional_float(lat),
        "lon": optional_float(lon),
        "pixelX": optional_float(pixel_x),
        "pixelY": optional_float(pixel_y),
        "geometry": geometry,
        "pixelPoints": pixel_points,
        "sortOrder": int(sort_order if sort_order is not None else payload.get("sortOrder", props.get("sortOrder", 0)) or 0),
        "isDim": is_dim,
        "isVisible": is_visible,
        "createdAt": payload.get("createdAt") or props.get("createdAt"),
    }


def row_to_geojson_feature(row):
    properties = {
        "id": row["id"],
        "featureType": row["feature_type"],
        "title": row["title"],
        "name": row["title"],
        "text": row["text"],
        "mapKind": row["map_kind"],
        "displayKind": row["display_kind"],
        "styleCategory": row["style_category"],
        "isDim": bool(row["is_dim"]),
        "isVisible": bool(row["is_visible"]),
        "sortOrder": row["sort_order"],
    }
    if row["pixel_x"] is not None:
        properties["pixelX"] = row["pixel_x"]
    if row["pixel_y"] is not None:
        properties["pixelY"] = row["pixel_y"]
    if row["pixel_points_json"]:
        properties["pixelPoints"] = json.loads(row["pixel_points_json"])

    geometry = json.loads(row["geometry_json"]) if row["geometry_json"] else None
    if not geometry and row["feature_type"] == "stage" and row["lon"] is not None and row["lat"] is not None:
        geometry = {"type": "Point", "coordinates": [row["lon"], row["lat"]]}
    if not geometry and row["feature_type"] == "area":
        geometry = {"type": "Polygon", "coordinates": [[]]}

    return {"type": "Feature", "geometry": geometry, "properties": properties}


def admin_feature_payload(row):
    return {
        "id": row["id"],
        "festivalId": row["festival_id"],
        "featureType": row["feature_type"],
        "title": row["title"],
        "text": row["text"],
        "mapKind": row["map_kind"],
        "displayKind": row["display_kind"],
        "styleCategory": row["style_category"],
        "lat": row["lat"],
        "lon": row["lon"],
        "pixelX": row["pixel_x"],
        "pixelY": row["pixel_y"],
        "geometry": json.loads(row["geometry_json"]) if row["geometry_json"] else None,
        "pixelPoints": json.loads(row["pixel_points_json"]) if row["pixel_points_json"] else [],
        "sortOrder": row["sort_order"],
        "isDim": bool(row["is_dim"]),
        "isVisible": bool(row["is_visible"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def public_pin_payload(row):
    return {
        "id": row["id"],
        "x": row["x"],
        "y": row["y"],
        "label": row["label"],
        "isVisible": bool(row["is_visible"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def normalize_pixel_points(points):
    if not isinstance(points, list):
        return []
    normalized = []
    for point in points:
        if not isinstance(point, dict):
            continue
        x = optional_float(point.get("x"))
        y = optional_float(point.get("y"))
        if x is not None and y is not None:
            normalized.append({"x": x, "y": y})
    return normalized


def json_or_none(value):
    if value in (None, "", []):
        return None
    return json.dumps(value, separators=(",", ":"))


def clean_text(value, max_length):
    return str(value or "").strip()[:max_length]


def optional_float(value):
    if value in (None, ""):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def as_finite_float(value, field):
    number = optional_float(value)
    if number is None:
        raise ValueError(f"{field} moet een getal zijn")
    return number
