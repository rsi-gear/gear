"""Start/stop one explicitly selected retained rental under an independent deadline.

No create, destroy, model download, or account credential transfer is supported.
The remote instance guard must also be armed before starting model work.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def cli(config, *args):
    return subprocess.run([config['cli'], *args], capture_output=True, text=True, check=True, timeout=25)


def state(config):
    rows = json.loads(cli(config, 'show', 'instances', '--raw').stdout)
    matches = [row for row in rows if row['id'] == config['instanceId']]
    assert len(matches) == 1, 'selected instance is absent or ambiguous'
    row = matches[0]
    assert row.get('label') == config['label'], 'instance ownership label changed'
    return row


def safe(row):
    return {key: row.get(key) for key in ('id', 'label', 'actual_status', 'intended_status', 'cur_state', 'dph_total')}


def stopped(row):
    return row.get('actual_status') == 'exited' and row.get('intended_status') == 'stopped' and row.get('cur_state') == 'stopped'


def save(path, value):
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(value, indent=2)); pending.replace(path)


def stop(config, directory):
    # No acknowledged PUT or disappeared process is proof of a stopped rental.
    while True:
        try:
            row = state(config)
            if stopped(row):
                save(directory / 'stopped.json', {'time': time.time(), 'state': safe(row)})
                return safe(row)
            if row.get('intended_status') != 'stopped' or row.get('cur_state') != 'stopped':
                cli(config, 'stop', 'instance', str(config['instanceId']), '--raw')
        except Exception as error:
            save(directory / 'stop-error.json', {'time': time.time(), 'errorType': type(error).__name__})
        time.sleep(5)


def watch(config, directory):
    save(directory / 'watch-ready.json', {'pid': os.getpid(), 'deadline': config['deadline']})
    while time.time() < config['deadline'] and not (directory / 'stop-now').exists():
        if (directory / 'stopped.json').exists(): return
        time.sleep(1)
    stop(config, directory)


def start(config, directory):
    row = state(config)
    assert stopped(row), 'bounded session requires a stopped retained instance'
    assert type(row.get('dph_total')) in (float, int) and 0 <= row['dph_total'] <= config['maxHourly'] <= .60
    assert time.time() < config['deadline'] <= time.time() + 2700
    with (directory / 'watch.log').open('w') as log:
        child = subprocess.Popen([sys.executable, __file__, 'watch', str(directory)], stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    until = time.monotonic() + 10
    while not (directory / 'watch-ready.json').exists():
        assert child.poll() is None and time.monotonic() < until, 'independent watchdog did not start'
        time.sleep(.1)
    response = cli(config, 'start', 'instance', str(config['instanceId']), '--raw')
    # The instance listing may briefly lag a successful state mutation. Retain
    # the bounded CLI status text and wait for observation before declaring loss.
    save(directory / 'start-response.json', {'stdout': response.stdout[:4096], 'stderr': response.stderr[:4096]})
    until = time.monotonic() + 30
    while True:
        observed = state(config)
        if observed.get('intended_status') == 'running': break
        assert time.monotonic() < until, 'Vast did not record the requested instance start; inspect start-response.json'
        time.sleep(2)
    save(directory / 'started.json', {'time': time.time(), 'state': safe(row), 'watchPid': child.pid})
    return {'instanceId': config['instanceId'], 'deadline': config['deadline'], 'watchPid': child.pid}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['start', 'watch', 'stop', 'state'])
    parser.add_argument('directory', type=Path); options = parser.parse_args()
    directory = options.directory.resolve(); config = json.loads((directory / 'session.json').read_text())
    if options.action == 'watch': watch(config, directory)
    elif options.action == 'start': print(json.dumps(start(config, directory)), flush=True)
    elif options.action == 'stop':
        (directory / 'stop-now').touch()
        print(json.dumps(stop(config, directory)), flush=True)
    else: print(json.dumps(safe(state(config))), flush=True)


if __name__ == '__main__': main()
