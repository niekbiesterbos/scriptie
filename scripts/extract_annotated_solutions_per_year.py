import json
import os


input_path = "../data/solutions_with_metrics.json"
output_dir = "../data/accuracy_tests"
TARGET_YEARS = set(range(2015, 2025))
DAYS = set(range(1, 26))


def extract_one_solution_per_day_per_year(data):
    selected = {}
    for item in data:
        year = item.get("year")
        day = item.get("day")
        if year in TARGET_YEARS and day in DAYS:
            key = (year, day)
            if key not in selected:
                part1 = item.get("part1")
                strategies = item.get("algorithmicStrategies", [])
                strategy_first = strategies[0] if strategies else None
                selected[key] = {
                    "year": year,
                    "day": day,
                    "part1": part1,
                    "strategy": strategy_first
                }
    return selected


def write_outputs(selected):
    os.makedirs(output_dir, exist_ok=True)
    years = TARGET_YEARS

    for year in years:
        code_with_label = []
        code_only = []
        for key in sorted(selected):
            y, d = key
            if y == year:
                item = selected[key]
                code_with_label.append({
                    "day": d,
                    "strategy": item["strategy"],
                    "part1": item["part1"]
                })
                code_only.append({
                    "day": d,
                    "part1": item["part1"]
                })

        with open(f"{output_dir}/{year}_with_labels.json", "w", encoding="utf-8") as f:
            json.dump(code_with_label, f, ensure_ascii=False, indent=2)

        with open(f"{output_dir}/{year}_code_only.json", "w", encoding="utf-8") as f:
            json.dump(code_only, f, ensure_ascii=False, indent=2)


with open(input_path, "r", encoding="utf-8") as infile:
    raw_data = json.load(infile)

selected_data = extract_one_solution_per_day_per_year(raw_data)
write_outputs(selected_data)


(len(selected_data), sorted(selected_data))
