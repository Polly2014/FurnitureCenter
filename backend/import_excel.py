import argparse
import json
from pathlib import Path

from backend.infrastructure.database import Base, SessionLocal, engine
from backend.infrastructure.excel_import import import_workbook


def main() -> None:
    parser = argparse.ArgumentParser(description="Import the initial furniture workbook")
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--apply", action="store_true", help="Write parsed records to the database")
    parser.add_argument(
        "--replace-catalog",
        action="store_true",
        help="Delete the existing catalog before applying the workbook",
    )
    args = parser.parse_args()
    if args.replace_catalog and not args.apply:
        parser.error("--replace-catalog requires --apply")

    Base.metadata.create_all(engine)
    with SessionLocal() as session:
        report = import_workbook(
            session,
            args.workbook,
            dry_run=not args.apply,
            replace_catalog=args.replace_catalog,
        )
    print(json.dumps(report.model_dump(), ensure_ascii=False, indent=2))
    if report.errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
