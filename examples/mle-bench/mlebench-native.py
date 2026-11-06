"""Use MLE-bench's public Registry/Grader API without leaderboard fabrication."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'grade'])
    parser.add_argument('--data-root', required=True); parser.add_argument('--competition', required=True)
    parser.add_argument('--submission')
    args = parser.parse_args()
    from mlebench.registry import Registry
    from mlebench.utils import read_csv
    competition = Registry(Path(args.data_root)).get_competition(args.competition)
    if args.action == 'prepare':
        if competition.public_dir.exists() or competition.private_dir.exists():
            raise ValueError('prepared output already exists')
        competition.public_dir.mkdir(parents=True); competition.private_dir.mkdir(parents=True)
        competition.prepare_fn(competition.raw_dir, competition.public_dir, competition.private_dir)
        print(json.dumps({'competition_id': competition.id, 'public': str(competition.public_dir), 'private': str(competition.private_dir)}))
    else:
        submission, answers = read_csv(Path(args.submission)), read_csv(competition.answers)
        raw = float(competition.grader.grade_fn(submission, answers))
        print(json.dumps({'competition_id': competition.id, 'raw_score': raw, 'score': competition.grader(submission, answers),
            'valid_submission': True, 'grader': competition.grader.name, 'medals': None}))


if __name__ == '__main__':
    main()
