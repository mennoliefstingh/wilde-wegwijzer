#!/usr/bin/env python3
import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import DEFAULT_FESTIVAL_ID, init_database, seed_database  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Seed Wilde Wegwijzer SQLite database")
    parser.add_argument("--db", required=True, help="Path naar de SQLite database")
    parser.add_argument("--seed", default=str(ROOT / "seed" / "wilde-weide-2026.json"), help="Seed JSON")
    parser.add_argument("--reset", action="store_true", help="Verwijder bestaande data voor dit festival eerst")
    parser.add_argument("--only-if-empty", action="store_true", help="Seed alleen als dit festival nog geen features heeft")
    args = parser.parse_args()

    seed_path = Path(args.seed)
    if not seed_path.exists():
        raise SystemExit(f"Seed niet gevonden: {seed_path}")

    init_database(args.db)
    changed = seed_database(args.db, seed_path, reset=args.reset, only_if_empty=args.only_if_empty)
    if changed:
        print(f"Seed geladen uit {seed_path} naar {args.db}")
    else:
        print(f"Database bevat al data voor {DEFAULT_FESTIVAL_ID}; niets gewijzigd")


if __name__ == "__main__":
    main()
