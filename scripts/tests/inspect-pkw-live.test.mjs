import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const inventory = fileURLToPath(new URL('../inspect-pkw-live.py', import.meta.url))
const setup = String.raw`
import builtins, copy, hashlib, importlib.util, io, json, os, stat, subprocess, sys, tempfile
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pkw_live_inventory', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SECRET = 'SHOULD_NEVER_APPEAR_6735'

def fingerprint(root):
    result = {}
    for p in [root, *sorted(root.rglob('*'))]:
        s = p.lstat()
        value = [s.st_mode, s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]
        if stat.S_ISLNK(s.st_mode): value.append(os.readlink(p))
        elif stat.S_ISREG(s.st_mode): value.append(hashlib.sha256(p.read_bytes()).hexdigest())
        result[str(p.relative_to(root))] = value
    return result

class Fixture:
    def __init__(self, root):
        self.root = root
        self.proc = root / 'proc'
        self.repo = root / 'repo'
        self.profile = root / 'profile'
        self.data = root / 'data'
        self.runner = self.repo / 'scripts/serve-collaboration.mjs'
        self.config = root / 'collaboration.json'
        self.envfile = root / 'credentials.env'
        self.node = root / 'node'
        for p in [self.proc, self.repo / 'scripts', self.profile, self.data / 'spaces/sp_test']:
            p.mkdir(parents=True)
        (self.proc / 'sys/kernel/random').mkdir(parents=True)
        (self.proc / 'sys/kernel/random/boot_id').write_text('12345678-1234-1234-1234-123456789abc\n')
        self.runner.write_text('// fixture listener ' + SECRET)
        self.node.write_text('fixture executable')
        self.envfile.write_text('PKW_TEST_PASSWORD=' + SECRET)
        (self.profile / 'package.json').write_text(json.dumps({'packageManager':'pnpm@11.23.0','password':SECRET}))
        (self.profile / '.npmrc').write_text('//registry.example/:_authToken=' + SECRET)
        (self.profile / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
        (self.profile / 'pnpm-workspace.yaml').write_text('packages: []\n')
        for name in m.PKW_NAMES + list(m.PEER_NAMES):
            package = self.profile / 'node_modules' / name
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name':name,'version':'0.1.9-pkw.1','privateSetting':SECRET}))
        for path in [self.data / 'identity.sqlite', self.data / 'spaces/sp_test/state.sqlite']:
            path.write_bytes(b'not a real database: ' + SECRET.encode())
        (self.data / 'gateway.lock').write_text(json.dumps({'pid':1234,'createdAt':'2026-10-09T01:00:00Z','secret':SECRET}))
        self.config_value = {'dataPath':str(self.data),'publicOrigin':'https://user:' + SECRET + '@example.test:8443/pkw?token=' + SECRET + '#secret',
            'bootstrapUsername':SECRET,'bootstrapPasswordEnv':'PKW_TEST_PASSWORD',
            'retrieval':{'stub':{'apiKeyEnv':'PKW_TEST_API_KEY','baseUrl':'https://api.test/','kbId':'test-kb','url':'https://api.test/?secret=' + SECRET}},
            'password':SECRET,'authorization':'Bearer ' + SECRET}
        self.write_config(self.config_value)
        self.units = {}
        for unit, pid in zip(m.UNITS, [1234, 5678]):
            fragment = root / (unit + '.unit')
            fragment.write_text('[Service]\nEnvironment=PRIVATE=' + SECRET + '\n')
            self.units[unit] = {'Id':unit,'LoadState':'loaded','ActiveState':'active','SubState':'running',
                'MainPID':str(pid),'ControlPID':'0','NRestarts':'0','FragmentPath':str(fragment),'DropInPaths':'',
                'EnvironmentFiles':str(self.envfile) + ' (ignore_errors=no)','WorkingDirectory':str(self.repo),
                'User':'root','Group':'root','ControlGroup':'/system.slice/' + unit,'Restart':'on-failure','KillMode':'control-group',
                'TimeoutStopUSec':'30s','PartOf':'','BindsTo':'','Requires':'','Wants':'','Conflicts':'','PropagatesStopTo':'','StopWhenUnneeded':'no',
                'ExecStartPre':'{ argv[]=/secret-helper --token ' + SECRET + ' }', 'Environment':'PRIVATE=' + SECRET,
                'ExecStart':'RAW_CMD_CANARY ' + SECRET}
            p = self.proc / str(pid)
            p.mkdir()
            (p / 'stat').write_text(str(pid) + ' (node) S ' + '0 ' * 18 + '987654 ' + '0 ' * 30)
            (p / 'status').write_text('Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n')
            (p / 'exe').symlink_to(self.node)
            (p / 'cwd').symlink_to(self.repo)
            (p / 'environ').write_bytes(b'PRIVATE=' + SECRET.encode())
            (p / 'cmdline').write_bytes(b'/fixture/node\0dsh-web\0')
        self.write_argv()
        self.calls = {}
        self.blocked = []
        self.unit_override = None
        self.du_override = None
    def write_config(self, value):
        self.config.write_text(json.dumps(value))
    def write_argv(self, extra=None):
        args = [str(self.node),str(self.runner),'--profile',str(self.profile),'--config',str(self.config),'--port','3081']
        if extra: args.extend(extra)
        (self.proc / '1234/cmdline').write_bytes(('\0'.join(args) + '\0').encode())
    def unit_reader(self, name):
        self.calls[name] = self.calls.get(name, 0) + 1
        if self.unit_override: return self.unit_override(name, self.calls[name])
        return copy.deepcopy(self.units[name])
    def du_reader(self, path):
        if self.du_override: return self.du_override(path)
        return {'known':True,'bytes':512}
    def collect(self):
        old_open, old_io_open, old_os_open = builtins.open, io.open, os.open
        old_run, old_statvfs = m.subprocess.run, m.os.statvfs
        def guard(path):
            if isinstance(path, (str, bytes, os.PathLike)):
                p = Path(os.fsdecode(path))
                if p == self.envfile or p.name == 'environ' or p.suffix == '.sqlite':
                    self.blocked.append(str(p))
                    raise AssertionError('forbidden content read')
        def checked_open(path, *args, **kwargs):
            guard(path)
            return old_open(path, *args, **kwargs)
        def checked_io(path, *args, **kwargs):
            guard(path)
            return old_io_open(path, *args, **kwargs)
        def checked_os(path, *args, **kwargs):
            guard(path)
            return old_os_open(path, *args, **kwargs)
        def command_forbidden(*args, **kwargs):
            raise AssertionError('unexpected subprocess in injected inventory')
        builtins.open, io.open, os.open = checked_open, checked_io, checked_os
        m.subprocess.run = command_forbidden
        m.os.statvfs = lambda path: old_statvfs(self.root if str(path) == '/LlHmm9527' else path)
        try:
            return m.collect(unit_reader=self.unit_reader, proc_root=self.proc, du_reader=self.du_reader)
        finally:
            builtins.open, io.open, os.open = old_open, old_io_open, old_os_open
            m.subprocess.run, m.os.statvfs = old_run, old_statvfs

with tempfile.TemporaryDirectory(prefix='pkw-live-inventory-') as directory:
    f = Fixture(Path(directory).resolve())
`

function python(body) {
  const code = setup + body.split('\n').map(line => `    ${line}`).join('\n')
  const result = spawnSync('python3', ['-B', '-', inventory], {
    input: code, encoding: 'utf8', timeout: 7000, maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

function noSecrets(report) {
  assert.doesNotMatch(JSON.stringify(report), /SHOULD_NEVER_APPEAR|RAW_CMD_CANARY|Bearer |PRIVATE=/)
}

test('live inventory reads metadata without credentials or database content and does not mutate the fixture', () => {
  const result = python(`
before = fingerprint(f.root)
report = f.collect()
assert before == fingerprint(f.root), 'read-only inventory modified the fixture'
print(json.dumps({'report':report,'blockedReads':f.blocked,'unitCalls':f.calls}))
`)
  const { report } = result
  assert.equal(report.status, 'INVENTORY_COLLECTED', JSON.stringify(report.issues))
  assert.equal(report.servicesChanged, false)
  assert.equal(report.productionAcceptance, 'not_run')
  assert.equal(report.installedOnDisk.loadedRuntimeVerified, false)
  assert.equal(report.installedOnDisk.packages.length, 13)
  assert.deepEqual(report.stability.changed, false)
  assert.equal(report.configuration.publicOrigin, 'https://example.test:8443')
  assert.equal(report.configuration.publicOriginHadRemovedComponents, true)
  assert.equal(report.data['identity.sqlite'].exists, true)
  assert.equal(report.data['identity.sqlite'].sha256, undefined)
  assert.equal(report.data.lockRecord.matchesObservedMainPID, true)
  assert.equal(report.files['pkw-collaboration.service/EnvironmentFiles/0'].sha256, undefined)
  assert.equal(report.units['pkw-collaboration.service'].hooksPresent.ExecStartPre, true)
  assert.equal(report.units['pkw-collaboration.service'].ExecStart, undefined)
  assert.equal(report.units['pkw-collaboration.service'].Environment, undefined)
  assert.deepEqual(result.blockedReads, [])
  assert.equal(result.unitCalls['pkw-collaboration.service'], 2)
  noSecrets(report)
})

test('duplicate or unknown listener arguments cannot select configuration or leak their values', () => {
  const result = python(`
reports = []
for extra in [['--port','3082'], ['--config',SECRET], ['--password',SECRET], ['--profile=' + SECRET]]:
    f.write_argv(extra)
    reports.append(f.collect())
print(json.dumps(reports))
`)
  for (const report of result) {
    assert.equal(report.status, 'INVENTORY_INCOMPLETE')
    assert.equal(report.configuration, undefined)
    assert.ok(report.issues.some(item => item.code === 'UNRECOGNIZED_OR_DUPLICATE_ARGUMENT'))
    noSecrets(report)
  }
})

test('malformed configuration fields fail without echoing secret-bearing objects', () => {
  const reports = python(`
reports = []
for key, value in [('dataPath', {'password':SECRET}), ('publicOrigin', {'token':SECRET}),
                   ('bootstrapPasswordEnv', {'secret':SECRET}), ('retrieval', [{'password':SECRET}])]:
    config = copy.deepcopy(f.config_value)
    config[key] = value
    f.write_config(config)
    reports.append(f.collect())
print(json.dumps(reports))
`)
  for (const report of reports) {
    assert.equal(report.status, 'INVENTORY_INCOMPLETE')
    assert.equal(report.configuration, undefined)
    noSecrets(report)
  }
})

test('malformed systemd field types and unavailable systemd evidence never become collected output', () => {
  const reports = python(`
reports = []
for value in [{'password':SECRET}, [SECRET], 123, None]:
    f.units[m.UNITS[0]]['User'] = value
    reports.append(f.collect())
def unavailable(name, call):
    raise PermissionError(SECRET)
f.unit_override = unavailable
reports.append(f.collect())
print(json.dumps(reports))
`)
  for (const report of reports) {
    assert.equal(report.status, 'INVENTORY_INCOMPLETE')
    noSecrets(report)
  }
})

test('PID, restart counter or process identity changes invalidate a collected inventory', () => {
  const result = python(`
reports = []
for change in ['pid','restarts','startTicks']:
    f.calls.clear()
    def drift(name, call):
        unit = copy.deepcopy(f.units[name])
        if name == m.UNITS[0] and call == 2:
            if change == 'pid': unit['MainPID'] = '9999'
            elif change == 'restarts': unit['NRestarts'] = '1'
            else: (f.proc / '1234/stat').write_text('1234 (node) S ' + '0 ' * 18 + '987655 ' + '0 ' * 30)
        return unit
    f.unit_override = drift
    reports.append(f.collect())
print(json.dumps(reports))
`)
  for (const report of result) {
    assert.equal(report.status, 'INVENTORY_CHANGED')
    assert.equal(report.stability.changed, true)
  }
})

test('configuration FIFO and oversized inputs are rejected within the subprocess deadline', () => {
  const reports = python(`
f.config.unlink()
os.mkfifo(f.config)
fifo = f.collect()
f.config.unlink()
f.config.write_bytes(b' ' * (2097152 + 1))
oversized = f.collect()
print(json.dumps([fifo,oversized]))
`)
  assert.equal(reports[0].status, 'INVENTORY_INCOMPLETE')
  assert.ok(reports[0].issues.some(item => item.code === 'NOT_REGULAR_FILE'))
  assert.equal(reports[1].status, 'INVENTORY_INCOMPLETE')
  assert.ok(reports[1].issues.some(item => item.code === 'FILE_TOO_LARGE'))
})

test('unavailable or malformed size observations stay unknown and do not leak arbitrary payloads', () => {
  const reports = python(`
reports = []
for value in [{'known':False,'code':'DU_FAILED'}, {'known':True,'bytes':SECRET},
              {'known':True,'bytes':-1}, {'known':True,'bytes':True}, {'known':True}, {'known':False,'error':SECRET}]:
    f.du_override = lambda path, value=value: copy.deepcopy(value)
    reports.append(f.collect())
print(json.dumps(reports))
`)
  for (const report of reports) {
    assert.equal(report.status, 'INVENTORY_INCOMPLETE')
    assert.ok(report.issues.some(item => item.at.startsWith('size/')))
    noSecrets(report)
  }
})

test('systemd and disk usage commands are bounded read-only probes and preserve command failure', () => {
  const result = python(`
calls, errors, sizes = [], [], []
valid = b'Id=pkw-collaboration.service\\nActiveState=active\\nMainPID=1234\\nControlPID=0\\nNRestarts=0\\n'
def stub(returncode, stdout):
    def run(args, **kwargs):
        calls.append({'args':args,'timeout':kwargs.get('timeout'),'env':kwargs.get('env')})
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=SECRET.encode())
    return run
for returncode, output in [(1,valid),(0,valid + b'MainPID=1234\\n'),(0,b'MainPID=1234\\n'),(0,valid + b'Environment=PRIVATE=' + SECRET.encode())]:
    m.subprocess.run = stub(returncode, output)
    try:
        m.read_unit(m.UNITS[0])
        raise AssertionError('invalid systemctl result was accepted')
    except m.InventoryError as error:
        errors.append(error.code)
for returncode, output in [(1,b'1024\\t/private/data\\n'),(0,b'not-a-size\\t/private/data\\n'),(0,b'1024\\t/private/data\\n')]:
    m.subprocess.run = stub(returncode, output)
    sizes.append(m.du_bytes(f.data))
def unavailable(*args, **kwargs):
    raise subprocess.TimeoutExpired(SECRET, 8)
m.subprocess.run = unavailable
sizes.append(m.du_bytes(f.data))
print(json.dumps({'calls':calls,'errors':errors,'sizes':sizes}))
`)
  assert.deepEqual(result.errors, ['SYSTEMCTL_FAILED', 'UNIT_OUTPUT_INVALID', 'UNIT_OUTPUT_INCOMPLETE', 'UNIT_OUTPUT_INVALID'])
  for (const call of result.calls) {
    assert.ok(call.timeout > 0 && call.timeout <= 20)
    assert.deepEqual(call.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C' })
    if (call.args[0] === '/usr/bin/systemctl') {
      assert.equal(call.args[1], 'show')
      assert.ok(!call.args.includes('Environment'))
      assert.ok(!call.args.includes('ExecStart'))
    } else {
      assert.equal(call.args[0], '/usr/bin/du')
      assert.deepEqual(call.args.slice(1, 5), ['-s', '-x', '-B1', '--'])
    }
  }
  assert.deepEqual(result.sizes.map(item => item.known), [false, false, true, false])
  assert.equal(result.sizes[2].bytes, 1024)
  assert.equal(result.sizes[3].code, 'TimeoutExpired')
  noSecrets(result)
})
