import json
from pathlib import Path


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def compare_year(annotated, labeled):
    annotated_dict = {entry["day"]: entry["strategy"] for entry in annotated}
    labeled_dict = {entry["day"]: entry["strategy"] for entry in labeled}

    correct = 0
    total = 0
    mismatches = []

    for day in annotated_dict:
        if day in labeled_dict:
            total += 1
            if annotated_dict[day] == labeled_dict[day]:
                correct += 1
            else:
                mismatches.append({
                    "day": day,
                    "expected": annotated_dict[day],
                    "actual": labeled_dict[day]
                })
    return correct, total, mismatches


def main():
    base_dir = Path("../data/accuracy_tests")
    results = []

    for year in range(2015, 2025):
        ann_path = base_dir / f"{year}_annotated.json"
        lbl_path = base_dir / f"{year}_with_labels.json"

        if not ann_path.exists() or not lbl_path.exists():
            print(f"[!] Skipping {year}: missing files.")
            continue

        annotated = load_json(ann_path)
        labeled = load_json(lbl_path)
        correct, total, mismatches = compare_year(annotated, labeled)

        accuracy = (correct / total * 100) if total > 0 else 0.0
        results.append({
            "year": year,
            "correct": correct,
            "total": total,
            "accuracy": round(accuracy, 2),
            "errors": mismatches
        })

    for r in results:
        print(f"{r['year']}: {r['correct']}/{r['total']} correct "
              f"({r['accuracy']}%)")
        if r["errors"]:
            print("  Mismatches:")
            for e in r["errors"]:
                print(
                    f"    Day {e['day']:>2}: expected {e['expected']}, got {e['actual']}")
        print()


if __name__ == "__main__":
    main()
