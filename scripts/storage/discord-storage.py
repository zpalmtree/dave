#!/usr/bin/env python3
"""User-owned gocryptfs storage and fail-closed PM2 launcher (Linux)."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

CONFIG = Path.home() / '.config/discord-storage/config.json'


def mounted(config):
    target = str(Path(config['mount']).resolve())
    # Do not accept an arbitrary filesystem mounted over the protected path.
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        if fields[4] == target and fields[fields.index('-') + 1] == 'fuse.gocryptfs':
            return True
    return False


def ensure(config):
    with (CONFIG.parent / 'mount.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if mounted(config):
            return
        target = Path(config['mount'])
        if not target.is_dir() or os.path.ismount(target):
            raise RuntimeError('Encrypted mount point unavailable')
        password = Path(config['passfile'])
        if not password.is_file() or password.stat().st_mode & 0o077:
            raise RuntimeError('Unlock credential missing or not private')
        target.chmod(0o700)
        try:
            if any(target.iterdir()):
                raise RuntimeError('Encrypted mount point must be empty')
            subprocess.run([
                config['gocryptfs'], '-q', '-nosyslog',
                '-passfile', str(password), config['cipher'], str(target),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=60, close_fds=True)
            if not mounted(config):
                raise RuntimeError('Encrypted mount was not established')
        finally:
            if not mounted(config):
                target.chmod(0o000)


def protected_path(config, path):
    root = Path(config['mount']).resolve()
    result = Path(path).resolve()
    if root not in result.parents:
        raise RuntimeError('Runtime path is outside encrypted storage')
    return result


def main():
    os.umask(0o077)
    config = json.loads(CONFIG.read_text())
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'status':
        print('mounted' if mounted(config) else 'locked')
        return 0 if mounted(config) else 1
    if action == 'ensure':
        ensure(config)
        return 0
    if action == 'rotate':
        if not mounted(config):
            return 0
        subprocess.run(['/usr/sbin/logrotate', '--state',
                        str(protected_path(config, config['mount'] + '/logrotate.state')),
                        str(CONFIG.parent / 'logrotate.conf')], check=True)
        return 0
    if action != 'run' or len(sys.argv) != 3:
        raise RuntimeError('Usage: discord-storage status|ensure|rotate|run SERVICE')
    name = sys.argv[2]
    if not re.fullmatch(r'[a-z0-9-]+', name):
        raise RuntimeError('Invalid service name')
    service = config['services'][name]
    ensure(config)
    cwd = protected_path(config, service['cwd'])
    tmp = protected_path(config, config['mount'] + '/tmp/' + name)
    logs = protected_path(config, config['mount'] + '/logs')
    tmp.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    # PM2 uses /dev/null; it must not open plaintext logs before we unlock.
    for number, suffix in [(1, 'out'), (2, 'error')]:
        fd = os.open(logs / (name + '-' + suffix + '.log'),
                     os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        os.dup2(fd, number)
        os.close(fd)
    env = dict(os.environ, **service.get('env', {}))
    env.update(TMPDIR=str(tmp), TMP=str(tmp), TEMP=str(tmp))
    os.chdir(cwd)
    command = service['command']
    os.execvpe(command[0], command, env)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Never print configuration/credentials or exception arguments.
        print('Encrypted storage startup failed (' + type(error).__name__ + ')', file=sys.stderr)
        sys.exit(78)
