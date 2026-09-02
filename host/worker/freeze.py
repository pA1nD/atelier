#!/usr/bin/env python3
"""freeze.py freeze|thaw|cleanup <instance> <slug> <workeruid> <appgid> [--dirfd N] [--dest <rel>]
(runs as userns-root with caps {SETUID, SETGID, CHOWN, KILL} only — no DAC caps, no FOWNER)

Layout (DESIGN §3): scratch/<instance> is root:appgid 0750 holding home/ (the worker's npm HOME + cache,
never touched here) and build/ (the worker's install dir: package.json copy, node_modules).

freeze:  build/node_modules (worker-owned) -> /work/apps/<slug>/node_modules owned 1000:appgid, dirs |050 files |040,
         no group/other write, no setuid/setgid; package-lock.json copied beside it.
thaw:    the reverse, so the worker can re-run `npm install` in place (second install = no-op). A no-op when the
         app folder holds no node_modules.
cleanup: after an aborted freeze — take every dir, remove node_modules + lock from build/, hand build/ back.

Mechanism: the worker's processes are SIGKILLed first (CAP_KILL); every step is dirfd-relative (openat /
renameat-style rename with dir fds / fchownat AT_SYMLINK_NOFOLLOW), O_NOFOLLOW|O_DIRECTORY on every component
below the root-owned scratch dir; every inode is lstat-verified worker-owned, not a symlink target, not a
hardlink (nlink>1) before it is touched; a dir is chowned to root BEFORE it is opened (how root enters a worker
0700 dir without DAC_OVERRIDE) and chmod'ed while root owns it (no CAP_FOWNER needed); files with g/o-write bits
are chowned to root, chmod'ed, then handed on; a setuid/setgid file aborts before any chown (its chown would be
an implicit kill-suid chmod = FOWNER). The rename into the agent-owned app folder runs in a forked child AS
uid 1000 with O_NOFOLLOW dirfds (root never writes into the agent's tree).

--dirfd N: the .atelier directory fd inherited from the host (its fd 3); `scratch` is opened relative to it so
a renamed /work/.atelier cannot redirect the walk. Without it the absolute path is used (the drill's shell).
--dest <rel> (freeze only; DESIGN §10.3 D8): the PROD export `prod/<inst>/<commit12>` relative to the dirfd — a
root-owned `0:appgid 0750` tree. The walk chowns build/node_modules to root:appgid (the same setuid/setgid,
symlink and hardlink refusals), an existing dest/node_modules is removed, the tree is renamed in AS ROOT (root
owns both dirs; no agent step, nothing in the agent's tree is touched) and build/ is handed back to the worker.
"""
import os, sys, stat, time, shutil, signal

ATELIER = '/work/.atelier'; APPS = '/work/apps'; AGENT = 1000
mode, inst, app, WUID, AGID = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
DIRFD = int(sys.argv[sys.argv.index('--dirfd') + 1]) if '--dirfd' in sys.argv else None
DEST = sys.argv[sys.argv.index('--dest') + 1] if '--dest' in sys.argv else None
O_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
STRIP = 0o6022   # setuid, setgid, group-write, other-write
DIR_MIN, FILE_MIN = 0o050, 0o040   # the worker (group appgid) must still traverse/read what it installed
T = {'fixed_mode': 0}
def norm(m, isdir): return (m & ~STRIP) | (DIR_MIN if isdir else FILE_MIN)

def die(msg):
    print(f'FREEZE-ABORT {mode} {app}: {msg}'); sys.exit(2)

def lstat_at(name, dfd):
    return os.stat(name, dir_fd=dfd, follow_symlinks=False)

def opendir(name, dfd=None, want_uid=None):
    try:
        fd = os.open(name, O_DIR, dir_fd=dfd)
    except OSError as e:
        die(f'open {name}: {e.strerror} errno={e.errno}')
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode): die(f'{name} is not a directory')
    if want_uid is not None and st.st_uid != want_uid: die(f'{name} owned by uid {st.st_uid}, want {want_uid}')
    return fd

def take_dir(name, dfd, from_uid):
    """verify <name> under dfd is a real dir owned by from_uid, chown it to root, open it (O_NOFOLLOW)."""
    st = lstat_at(name, dfd)
    if stat.S_ISLNK(st.st_mode): die(f'{name} is a symlink (uid {st.st_uid})')
    if not stat.S_ISDIR(st.st_mode): die(f'{name} is not a directory')
    if st.st_uid != from_uid: die(f'{name} owned by uid {st.st_uid}, want {from_uid}')
    os.chown(name, 0, st.st_gid, dir_fd=dfd, follow_symlinks=False)
    fd = opendir(name, dfd, want_uid=0)
    m = stat.S_IMODE(st.st_mode)
    if norm(m, True) != m:
        os.fchmod(fd, norm(m, True)); T['fixed_mode'] += 1   # root owns it now: no CAP_FOWNER needed
    return fd

def chown_walk(fd, from_uid, to_uid, to_gid):
    """chown everything below fd from from_uid to to_uid:to_gid. Never follows symlinks; a foreign
    inode (hardlink to someone else's file, planted dir) aborts. Dirs are taken by root to enter."""
    n = 0
    for e in os.scandir(fd):
        st = e.stat(follow_symlinks=False)
        if st.st_uid != from_uid: die(f'foreign inode {e.name} uid={st.st_uid} nlink={st.st_nlink}')
        if stat.S_ISDIR(st.st_mode):
            sub = take_dir(e.name, fd, from_uid)
            n += chown_walk(sub, from_uid, to_uid, to_gid)
            os.fchown(sub, to_uid, to_gid); os.close(sub)
        else:
            if st.st_nlink > 1 and stat.S_ISREG(st.st_mode): die(f'hardlinked inode {e.name} nlink={st.st_nlink}')
            m = stat.S_IMODE(st.st_mode)
            if stat.S_ISREG(st.st_mode) and m & 0o6000:
                # chown of a foreign setuid/setgid file = implicit chmod (ATTR_KILL_SUID) -> EPERM without CAP_FOWNER;
                # a legitimate install never needs one: refuse before touching anything else
                die(f'setuid/setgid file {e.name} mode={m:o} refused')
            if stat.S_ISREG(st.st_mode) and norm(m, False) != m:
                # chmod while root owns it: no CAP_FOWNER needed (worker is dead, lstat said regular file)
                os.chown(e.name, 0, st.st_gid, dir_fd=fd, follow_symlinks=False)
                os.chmod(e.name, norm(m, False), dir_fd=fd); T['fixed_mode'] += 1
            os.chown(e.name, to_uid, to_gid, dir_fd=fd, follow_symlinks=False)
        n += 1
    return n

def kill_uid(uid):
    k = 0
    for p in os.listdir('/proc'):
        if not p.isdigit(): continue
        try:
            with open(f'/proc/{p}/status') as f:
                for line in f:
                    if line.startswith('Uid:') and int(line.split()[1]) == uid:
                        os.kill(int(p), signal.SIGKILL); k += 1; break
        except OSError: pass
    return k

def as_agent(fn):
    """run fn() in a forked child as uid 1000 (groups = [appgid]); inherit open dirfds."""
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([AGID]); os.setresgid(AGENT, AGENT, AGENT); os.setresuid(AGENT, AGENT, AGENT)
            fn(); os._exit(0)
        except BaseException as e:
            print(f'FREEZE-ABORT {mode} {app}: agent-step {type(e).__name__}: {e}'); os._exit(2)
    _, status = os.waitpid(pid, 0)
    if status != 0: sys.exit(2)

def copy_at(src_name, sfd, dst_name, dfd, mode_bits=0o644):
    s = os.open(src_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=sfd)
    d = os.open(dst_name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode_bits, dir_fd=dfd)
    with os.fdopen(s, 'rb') as fi, os.fdopen(d, 'wb') as fo: shutil.copyfileobj(fi, fo)

if mode not in ('freeze', 'thaw', 'cleanup'): die('mode?')
if DEST is not None and (DEST.startswith('/') or '..' in DEST.split('/')): die(f'dest must be dirfd-relative: {DEST}')
t0 = time.monotonic()
sfd = opendir('scratch', DIRFD, want_uid=0) if DIRFD is not None else opendir(f'{ATELIER}/scratch', want_uid=0)

if mode == 'freeze' and DEST is not None:
    T['killed'] = kill_uid(WUID)
    dfd = opendir(DEST, DIRFD, want_uid=0) if DIRFD is not None else opendir(f'{ATELIER}/{DEST}', want_uid=0)
    ifd = opendir(inst, sfd, want_uid=0)
    bfd = take_dir('build', ifd, WUID)
    nfd = take_dir('node_modules', bfd, WUID)
    T['files'] = chown_walk(nfd, WUID, 0, AGID)
    os.fchown(nfd, 0, AGID); os.close(nfd)
    has_lock = False
    try:
        st = lstat_at('package-lock.json', bfd)
        if stat.S_ISREG(st.st_mode) and st.st_uid == WUID and st.st_nlink == 1:
            os.chown('package-lock.json', 0, AGID, dir_fd=bfd, follow_symlinks=False); has_lock = True
    except FileNotFoundError: pass
    T['chown_ms'] = round((time.monotonic() - t0) * 1000, 1)
    t1 = time.monotonic()
    try:
        st = lstat_at('node_modules', dfd)
        if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode): shutil.rmtree('node_modules', dir_fd=dfd)
        else: os.unlink('node_modules', dir_fd=dfd)
    except FileNotFoundError: pass
    os.rename('node_modules', 'node_modules', src_dir_fd=bfd, dst_dir_fd=dfd)
    if has_lock:
        copy_at('package-lock.json', bfd, 'package-lock.json', dfd, 0o640)
        os.chown('package-lock.json', 0, AGID, dir_fd=dfd, follow_symlinks=False)
        os.unlink('package-lock.json', dir_fd=bfd)
    os.fchown(bfd, WUID, AGID)               # build/ back to the worker: the next install runs in place (thaw = no-op)
    T['rename_ms'] = round((time.monotonic() - t1) * 1000, 1)

elif mode == 'freeze':
    T['killed'] = kill_uid(WUID)
    ifd = opendir(inst, sfd, want_uid=0)     # instance dir is root:appgid 0750 (home/ and build/ inside are the worker's)
    bfd = take_dir('build', ifd, WUID)       # build dir -> root
    nfd = take_dir('node_modules', bfd, WUID)  # must be a real worker-owned dir (symlink -> abort)
    T['files'] = chown_walk(nfd, WUID, AGENT, AGID)
    os.fchown(nfd, AGENT, AGID); os.close(nfd)
    has_lock = False
    try:
        st = lstat_at('package-lock.json', bfd)
        if stat.S_ISREG(st.st_mode) and st.st_uid == WUID and st.st_nlink == 1:
            os.chown('package-lock.json', AGENT, AGID, dir_fd=bfd, follow_symlinks=False); has_lock = True
    except FileNotFoundError: pass
    os.fchown(bfd, AGENT, AGENT)             # hand build to the agent for the rename (inst stays root 0750)
    T['chown_ms'] = round((time.monotonic() - t0) * 1000, 1)
    t1 = time.monotonic()
    def agent_step():
        afd = opendir(f'{APPS}/{app}', want_uid=AGENT)   # O_NOFOLLOW: a symlink planted by the agent is refused
        try:
            lstat_at('node_modules', afd)
            os.rename('node_modules', 'node_modules.old', src_dir_fd=afd, dst_dir_fd=bfd)
        except FileNotFoundError: pass
        os.rename('node_modules', 'node_modules', src_dir_fd=bfd, dst_dir_fd=afd)
        if has_lock: copy_at('package-lock.json', bfd, 'package-lock.json', afd)
        try: shutil.rmtree('node_modules.old', dir_fd=bfd)
        except FileNotFoundError: pass
    as_agent(agent_step)
    T['rename_ms'] = round((time.monotonic() - t1) * 1000, 1)

elif mode == 'thaw':
    ifd = opendir(inst, sfd, want_uid=0)
    st = lstat_at('build', ifd)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode): die('build is not a real directory')
    if st.st_uid == WUID:
        # nothing frozen (build/ is still the worker's): the next install runs in place
        T['files'] = 0; T['noop'] = 1
    else:
        bfd = opendir('build', ifd, want_uid=AGENT)
        def agent_step():
            afd = opendir(f'{APPS}/{app}', want_uid=AGENT)
            try: os.rename('node_modules', 'node_modules', src_dir_fd=afd, dst_dir_fd=bfd)
            except FileNotFoundError: pass
            try: copy_at('package-lock.json', afd, 'package-lock.json', bfd)
            except FileNotFoundError: pass
        as_agent(agent_step)
        T['rename_ms'] = round((time.monotonic() - t0) * 1000, 1)
        t1 = time.monotonic()
        try:
            nfd = take_dir('node_modules', bfd, AGENT)
            T['files'] = chown_walk(nfd, AGENT, WUID, AGID)
            os.fchown(nfd, WUID, AGID); os.close(nfd)
        except FileNotFoundError: T['files'] = 0
        try: os.chown('package-lock.json', WUID, AGID, dir_fd=bfd, follow_symlinks=False)
        except FileNotFoundError: pass
        os.fchown(bfd, WUID, AGID)
        T['chown_ms'] = round((time.monotonic() - t1) * 1000, 1)
elif mode == 'cleanup':
    # after an aborted freeze: build/ may be root-, worker- or agent-owned with a half-taken tree. Take every dir
    # (root can then unlink inside it without DAC caps), remove node_modules + lock, hand build back to the worker.
    T['killed'] = kill_uid(WUID)
    ifd = opendir(inst, sfd, want_uid=0)
    st = lstat_at('build', ifd)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode): die('build is not a real directory')
    os.chown('build', 0, AGID, dir_fd=ifd, follow_symlinks=False); bfd = opendir('build', ifd, want_uid=0)
    def take_all(fd):
        n = 0
        for e in os.scandir(fd):
            st = e.stat(follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                os.chown(e.name, 0, st.st_gid, dir_fd=fd, follow_symlinks=False)
                sub = opendir(e.name, fd, want_uid=0); os.fchmod(sub, 0o700); n += 1 + take_all(sub); os.close(sub)
        return n
    try:
        st = lstat_at('node_modules', bfd)
        if stat.S_ISDIR(st.st_mode):
            os.chown('node_modules', 0, st.st_gid, dir_fd=bfd, follow_symlinks=False)
            nfd = opendir('node_modules', bfd, want_uid=0); os.fchmod(nfd, 0o700); T['dirs_taken'] = take_all(nfd); os.close(nfd)
            shutil.rmtree('node_modules', dir_fd=bfd)
        else: os.unlink('node_modules', dir_fd=bfd)
    except FileNotFoundError: pass
    try: os.unlink('package-lock.json', dir_fd=bfd)
    except FileNotFoundError: pass
    os.fchmod(bfd, 0o755); os.fchown(bfd, WUID, AGID)

T['total_ms'] = round((time.monotonic() - t0) * 1000, 1)
print(f'FREEZE-OK {mode} {app} ' + ' '.join(f'{k}={v}' for k, v in T.items()))
