import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { definition, makeSandbox, type Sandbox } from "./beads-sandbox.js";

// O Bead Board lê as visões geradas (aiteam/docs/beads-schema.md §7). Quem
// edita um bead e abre o board sem passar por hook nenhum veria a visão velha:
// o server.py regenera quando a fonte é mais nova. Roda o Python de verdade
// contra um repo descartável; sem Python na máquina, o teste é pulado.

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "bead_board");
const PYTHON = ["python3", "python", "py"].find((bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0);

let sb: Sandbox | undefined;
afterEach(() => sb?.cleanup());

function board(root: string, code: string): any {
  const script = [
    "import json, pathlib, sys",
    `sys.path.insert(0, ${JSON.stringify(SERVER_DIR)})`,
    "import server",
    `root = pathlib.Path(${JSON.stringify(root)})`,
    code,
  ].join("\n");
  const r = spawnSync(PYTHON!, ["-c", script], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`python falhou: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

describe.skipIf(!PYTHON)("Bead Board server.py — visão velha é regenerada", () => {
  it("fonte mais nova que a visão → stale → regenera com argv fixo → em dia", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "feat/board" });
    const s = sb;
    s.write(".beads/tasks/ui-a/feat-board.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "a");

    const first = board(s.dir, "print(json.dumps({'stale': server.views_stale(root), 'branch': server.current_branch(root)}))");
    expect(first).toEqual({ stale: true, branch: "feat/board" });

    const regen = board(s.dir, "ok = server.regenerate_views(root); print(json.dumps({'ok': ok, 'stale': server.views_stale(root)}))");
    expect(regen).toEqual({ ok: true, stale: false });
    expect(s.read(".beads/active.yaml")).toMatch(/^# GERADO/);

    const future = new Date(Date.now() + 5_000);
    s.write(".beads/tasks/ui-b/feat-board.yaml", definition("B", "2026-10-02T10:00:00Z"));
    fs.utimesSync(path.join(s.dir, ".beads", "tasks", "ui-b", "feat-board.yaml"), future, future);
    expect(board(s.dir, "print(json.dumps(server.views_stale(root)))")).toBe(true);
    board(s.dir, "print(json.dumps(server.regenerate_views(root)))");
    expect(s.read(".beads/active.yaml")).toMatch(/ui-b/);
  });

  // Outras branches e worktrees (fase 2 da #37): o board pede ao comando `beads`,
  // com argv fixo, sem shell e timeout, e guarda o resultado por 15 s — o Kanban
  // consulta /api/state a cada 2 s.
  it("elsewhere: argv fixo, sem shell, e cache de 15 s", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.write(".beads/.gitignore", "/active.yaml\n/index.yaml\n");
    s.write(".beads/tasks/api-a/main.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "base");
    s.git("checkout", "-q", "-b", "worktree-agent-x");
    s.write(".beads/tasks/orch-n/worktree-agent-x.yaml", `${definition("Novo da outra branch", "2026-10-02T10:00:00Z")}entries:\n  - at: "2026-10-02T11:00:00Z"\n    status: "in_progress"\n`);
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "n");
    s.git("checkout", "-q", "main");

    const r = board(
      s.dir,
      [
        "calls = []",
        "orig = server.subprocess.Popen",
        "class Rec(orig):  # o comando roda por Popen (o filho fica guardado para o atexit matar)",
        "    def __init__(self, argv, **k):",
        "        calls.append({'argv': [str(x) for x in argv], 'shell': k.get('shell', False)})",
        "        super().__init__(argv, **k)",
        "    def communicate(self, input=None, timeout=None):",
        "        calls[-1]['timeout'] = timeout",
        "        return super().communicate(input, timeout)",
        "server.subprocess.Popen = Rec",
        "first = server.elsewhere_state(root)",
        "second = server.elsewhere_state(root)",
        "fresh = server.elsewhere_state(root, ttl=0)",
        "print(json.dumps({'first': first, 'same': first == second, 'n': len(calls), 'call': calls[0], 'fresh': fresh == first}))",
      ].join("\n")
    );
    expect(r.first.available).toBe(true);
    expect(r.first.partial).toBe(false);
    expect(r.first.stale).toBe(false);
    expect(r.first.elsewhere.map((e: any) => e.id)).toEqual(["orch-n"]);
    expect(r.first.elsewhere[0]).toMatchObject({ aqui: null, la: { status: "in_progress" } });
    expect(r.first.elsewhere[0].fontes[0].origem).toMatch(/^worktree-agent-x \(local [0-9a-f]{7}\)$/);
    expect(r.same).toBe(true);
    expect(r.n).toBe(2); // o primeiro roda o comando; o segundo vem do cache; o terceiro (ttl=0) roda de novo
    expect(r.call.argv.slice(1)).toEqual([path.join(s.dir, "aiteam", "scripts", "beads.mjs"), "status", "--json", "--quiet"]);
    expect(r.call.shell).toBe(false);
    expect(r.call.timeout).toBe(20); // acima do prazo interno do comando (15 s): ver o teste abaixo
    expect(r.fresh).toBe(true);
  });

  // O `beads status` tem prazo interno de 15 s (AGGREGATE_DEADLINE_MS em beads-cmd.mjs): estourado,
  // ele devolve `partial: true` com o que leu. Se o servidor o matasse antes (era 10 s), o parcial
  // por prazo nunca chegaria à UI e uma execução lenta viraria "indisponível". Como a renovação é
  // em segundo plano, o servidor pode esperar mais que o comando.
  it("elsewhere: o timeout do servidor passa do prazo interno do comando, senão o parcial por prazo nunca chega", () => {
    const cmd = fs.readFileSync(path.join(SERVER_DIR, "..", "..", "src", "beads-cmd.mjs"), "utf8");
    const deadline = Number(/const AGGREGATE_DEADLINE_MS = ([\d_]+);/.exec(cmd)![1]!.replaceAll("_", "")) / 1000;
    const r = board(SERVER_DIR, "print(json.dumps({'timeout': server.ELSEWHERE_TIMEOUT}))");
    expect(r.timeout).toBeGreaterThan(deadline);
  });

  it("elsewhere: sem node ou sem o script, o board segue (lista vazia, available false)", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.remove("aiteam/scripts/beads.mjs");
    const r = board(s.dir, "print(json.dumps(server.elsewhere_state(root, ttl=0)))");
    expect(r).toEqual({ elsewhere: [], partial: false, available: false, stale: false });
  });

  // B-A4: a saída do comando que não é um objeto JSON (lista, null, texto) dava 500 no
  // /api/state. Qualquer coisa fora do contrato vira "sem elsewhere".
  it("elsewhere: saída que não é um objeto não derruba o /api/state", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    const r = board(
      s.dir,
      [
        "class R:",
        "    def __init__(self, out, code=0): self.stdout = out; self.returncode = code",
        "res = {}",
        "for name, out in [('lista', b'[]'), ('nulo', b'null'), ('texto', b'\"x\"'), ('sem_chave', b'{}'), ('lixo', b'nao e json')]:",
        "    server._run_command = lambda *a, **k: R(out)",
        "    res[name] = server.elsewhere_state(root, ttl=0)",
        "print(json.dumps(res))",
      ].join("\n")
    );
    expect(r.lista).toEqual({ elsewhere: [], partial: false, available: true, stale: false });
    expect(r.nulo).toEqual({ elsewhere: [], partial: false, available: true, stale: false });
    expect(r.texto).toEqual({ elsewhere: [], partial: false, available: true, stale: false });
    expect(r.sem_chave).toEqual({ elsewhere: [], partial: false, available: true, stale: false });
    expect(r.lixo).toEqual({ elsewhere: [], partial: false, available: false, stale: false });
  });

  // O servidor é de uma thread só (socketserver.TCPServer): o `beads status` com 600 beads leva
  // ~2 s, e rodá-lo no pedido travava o board inteiro a cada 15 s. Vencido o cache, serve o último
  // valor marcado como velho e renova numa thread de fundo, uma por vez.
  const OK = (id: string, extra = "") => `{'elsewhere': [{'id': '${id}'}], 'partial': False, 'available': True${extra}}`;

  it("elsewhere: cache vencido serve o último valor como velho sem esperar o comando, e renova uma vez em segundo plano", { timeout: 120_000 }, () => {
    const r = board(
      SERVER_DIR,
      [
        "import threading, time",
        "clock = [0.0]",
        "now = lambda: clock[0]",
        "gate = threading.Event()",
        "calls = []",
        "def fake(root, node=None, timeout=10):",
        "    calls.append(len(calls) + 1)",
        "    if len(calls) == 1:",
        `        return ${OK("v1")}`,
        "    gate.wait(30)",
        "    return {'elsewhere': [{'id': 'v2'}], 'partial': True, 'available': True}",
        "server._run_beads_status = fake",
        "ids = lambda r: [e['id'] for e in r['elsewhere']]",
        "cold = server.elsewhere_state(root, now=now)",
        "clock[0] = 14.0",
        "warm = server.elsewhere_state(root, now=now)",
        "clock[0] = 16.0",
        "t0 = time.monotonic()",
        "old = server.elsewhere_state(root, now=now)",
        "waited = time.monotonic() - t0",
        "again = [server.elsewhere_state(root, now=now) for _ in range(5)]",
        "while len(calls) < 2: time.sleep(0.01)",
        "n_running = len(calls)",
        "gate.set()",
        "renewed = None",
        "for _ in range(400):",
        "    renewed = server.elsewhere_state(root, now=now)",
        "    if not renewed['stale']: break",
        "    time.sleep(0.05)",
        "print(json.dumps({'cold': [ids(cold), cold['stale']], 'warm': [ids(warm), warm['stale']], 'old': [ids(old), old['stale']], 'waited': waited, 'again': [[ids(a), a['stale']] for a in again], 'n_running': n_running, 'renewed': [ids(renewed), renewed['stale'], renewed['partial']], 'n': len(calls)}))",
      ].join("\n")
    );
    expect(r.cold).toEqual([["v1"], false]); // frio: não há o que servir, roda o comando
    expect(r.warm).toEqual([["v1"], false]); // dentro dos 15 s
    expect(r.old).toEqual([["v1"], true]); // vencido: o último valor, marcado velho
    expect(r.waited).toBeLessThan(1); // o comando fica preso 30 s no gate: se o pedido esperasse por ele, passaria disso
    expect(r.again).toEqual(Array(5).fill([["v1"], true])); // com a renovação em curso, continua o velho
    expect(r.n_running).toBe(2); // e ninguém disparou uma segunda renovação
    expect(r.renewed).toEqual([["v2"], false, true]); // terminada, o valor novo entra, em dia
    expect(r.n).toBe(2);
  });

  it("elsewhere: renovação que falha ou estoura não deixa o cache preso; a que volta indisponível entra como indisponível", { timeout: 120_000 }, () => {
    const r = board(
      SERVER_DIR,
      [
        "import time",
        "clock = [0.0]",
        "now = lambda: clock[0]",
        "calls = []",
        "def fake(root, node=None, timeout=10):",
        "    calls.append(1)",
        "    n = len(calls)",
        `    if n == 1: return ${OK("v1")}`,
        "    if n == 2: raise RuntimeError('inesperado')",
        "    return {'elsewhere': [], 'partial': False, 'available': False}",
        "server._run_beads_status = fake",
        "def wait_calls(n):",
        "    for _ in range(400):",
        "        if len(calls) >= n: break",
        "        time.sleep(0.01)",
        "    time.sleep(0.1)  # a thread de fundo termina logo depois de rodar",
        "server.elsewhere_state(root, now=now)",
        "clock[0] = 16.0",
        "second = server.elsewhere_state(root, now=now)  # vencido: dispara a 2ª (que levanta exceção)",
        "wait_calls(2)",
        "third = server.elsewhere_state(root, now=now)  # a 2ª não guardou nada: segue velho, e dispara a 3ª",
        "wait_calls(3)",
        "last = server.elsewhere_state(root, now=now)",
        "print(json.dumps({'second': second, 'third': third, 'last': last, 'n': len(calls)}))",
      ].join("\n")
    );
    expect(r.second).toEqual({ elsewhere: [{ id: "v1" }], partial: false, available: true, stale: true });
    expect(r.third).toEqual({ elsewhere: [{ id: "v1" }], partial: false, available: true, stale: true });
    expect(r.last).toEqual({ elsewhere: [], partial: false, available: false, stale: false }); // honesto: o board mostra "indisponível"
    expect(r.n).toBe(3);
  });

  // O comando rodava em subprocess.run dentro da thread de fundo: no Ctrl+C ou no shutdown a thread
  // (daemon) morria e o timeout com ela, e o node filho ficava órfão até acabar sozinho. Agora o
  // filho em andamento fica guardado e o atexit o mata.
  it("elsewhere: _run_command devolve a saída, estoura o timeout matando o filho, e não deixa filho registrado", { timeout: 120_000 }, () => {
    const r = board(
      SERVER_DIR,
      [
        "import sys, time, subprocess",
        "ok = server._run_command([sys.executable, '-c', \"print('oi')\"], '.', 30)",
        "t0 = time.monotonic()",
        "try:",
        "    server._run_command([sys.executable, '-c', 'import time; time.sleep(120)'], '.', 1)",
        "    timed_out = False",
        "except subprocess.TimeoutExpired:",
        "    timed_out = True",
        "waited = time.monotonic() - t0",
        "print(json.dumps({'out': ok.stdout.decode().strip(), 'code': ok.returncode, 'timed_out': timed_out, 'waited': waited, 'left': len(server._children)}))",
      ].join("\n")
    );
    expect(r).toMatchObject({ out: "oi", code: 0, timed_out: true, left: 0 });
    expect(r.waited).toBeLessThan(20); // o filho dormia 120 s: foi morto no timeout, não esperado
  });

  it("elsewhere: ao sair, o servidor mata o comando em andamento (o node filho não fica órfão)", { timeout: 120_000 }, async () => {
    const script = [
      "import sys, threading, time, json",
      `sys.path.insert(0, ${JSON.stringify(SERVER_DIR)})`,
      "import server",
      "t = threading.Thread(target=lambda: server._run_command([sys.executable, '-c', 'import time; time.sleep(120)'], '.', 100), daemon=True)",
      "t.start()",
      "for _ in range(1000):",
      "    if server._children: break",
      "    time.sleep(0.01)",
      "print(json.dumps({'pid': list(server._children)[0].pid}), flush=True)",
      // acaba aqui, com a thread ainda dentro do comando: é o atexit que tem de matar o filho
    ].join("\n");
    const r = spawnSync(PYTHON!, ["-c", script], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const pid: number = JSON.parse(r.stdout.trim().split("\n").at(-1)!).pid;
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
      expect(alive(pid), "o filho sobreviveu à saída do servidor").toBe(false);
    } finally {
      try {
        process.kill(pid);
      } catch {
        /* já morreu, que é o esperado */
      }
    }
  });

  // `refreshing` é marcado antes do Thread.start(): se o start falhar (RuntimeError "can't start new
  // thread", sem memória), o flag ficava preso e o cache velho para sempre, sem nova tentativa.
  it("elsewhere: se a thread de fundo não consegue iniciar, o flag não prende e o pedido ainda recebe o valor velho", { timeout: 120_000 }, () => {
    const r = board(
      SERVER_DIR,
      [
        "import time",
        "clock = [0.0]",
        "now = lambda: clock[0]",
        "calls = []",
        "def fake(root, node=None, timeout=None):",
        "    calls.append(1)",
        "    return {'elsewhere': [{'id': 'v%d' % len(calls)}], 'partial': False, 'available': True}",
        "server._run_beads_status = fake",
        "ids = lambda r: [e['id'] for e in r['elsewhere']]",
        "server.elsewhere_state(root, now=now)",
        "clock[0] = 16.0",
        "real = server.threading.Thread",
        "class Boom:",
        "    def __init__(self, *a, **k): pass",
        "    def start(self): raise RuntimeError(\"can't start new thread\")",
        "server.threading.Thread = Boom",
        "try:",
        "    failed = server.elsewhere_state(root, now=now)",
        "finally:",
        "    server.threading.Thread = real",
        "retried = None",
        "for _ in range(200):",
        "    retried = server.elsewhere_state(root, now=now)",
        "    if not retried['stale']: break",
        "    time.sleep(0.05)",
        "print(json.dumps({'failed': [ids(failed), failed['stale']], 'retried': [ids(retried), retried['stale']], 'n': len(calls)}))",
      ].join("\n")
    );
    expect(r.failed).toEqual([["v1"], true]); // o pedido não quebra: recebe o último valor, velho
    expect(r.retried).toEqual([["v2"], false]); // e a próxima tentativa renova (o flag não ficou preso)
    expect(r.n).toBe(2);
  });

  it("/api/state não espera o comando lento: serve o último valor e diz que está velho", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    const r = board(
      s.dir,
      [
        "import socketserver, threading, time, urllib.request",
        "server.REPO_ROOT = root",
        "server.YAML_PATH = root / '.beads' / 'active.yaml'",
        "server.INDEX_PATH = root / '.beads' / 'index.yaml'",
        "server.LEGACY_INDEX_PATH = root / '.beads' / 'archive' / 'index.yaml'",
        "server.ELSEWHERE_TTL = 0.2",
        "slow = threading.Event()",
        "def fake(r, node=None, timeout=10):",
        "    if slow.is_set(): time.sleep(8)",
        `    return ${OK("orch-a")}`,
        "server._run_beads_status = fake",
        "httpd = socketserver.TCPServer(('127.0.0.1', 0), server.Handler)",
        "threading.Thread(target=httpd.serve_forever, daemon=True).start()",
        "url = 'http://127.0.0.1:%d/api/state' % httpd.server_address[1]",
        "get = lambda: json.loads(urllib.request.urlopen(url, timeout=60).read())",
        "first = get()",
        "slow.set()",
        "time.sleep(0.4)  # vence o cache de 0,2 s",
        "t0 = time.monotonic()",
        "second = get()",
        "waited = time.monotonic() - t0",
        "httpd.shutdown()",
        "print(json.dumps({'first': [first['elsewhere_stale'], [e['id'] for e in first['elsewhere']]], 'second': [second['elsewhere_stale'], [e['id'] for e in second['elsewhere']]], 'waited': waited}))",
      ].join("\n")
    );
    expect(r.first).toEqual([false, ["orch-a"]]);
    expect(r.second).toEqual([true, ["orch-a"]]);
    expect(r.waited).toBeLessThan(4); // o comando leva 8 s
  });

  it("/api/state traz o elsewhere (e o resto continua igual)", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.write(".beads/.gitignore", "/active.yaml\n/index.yaml\n");
    s.write(".beads/tasks/api-a/main.yaml", definition("A", "2026-10-01T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "base");
    s.git("checkout", "-q", "-b", "feat/o");
    s.write(".beads/tasks/orch-o/feat-o.yaml", definition("Só na feat/o", "2026-10-02T10:00:00Z"));
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "o");
    s.git("checkout", "-q", "main");

    const r = board(
      s.dir,
      [
        "import socketserver, threading, urllib.request",
        "server.REPO_ROOT = root",
        "server.YAML_PATH = root / '.beads' / 'active.yaml'",
        "server.INDEX_PATH = root / '.beads' / 'index.yaml'",
        "server.LEGACY_INDEX_PATH = root / '.beads' / 'archive' / 'index.yaml'",
        "httpd = socketserver.TCPServer(('127.0.0.1', 0), server.Handler)",
        "threading.Thread(target=httpd.serve_forever, daemon=True).start()",
        "data = json.loads(urllib.request.urlopen('http://127.0.0.1:%d/api/state' % httpd.server_address[1], timeout=60).read())",
        "httpd.shutdown()",
        "print(json.dumps({'keys': sorted(data), 'branch': data['branch'], 'elsewhere': data['elsewhere'], 'partial': data['elsewhere_partial'], 'available': data['elsewhere_available'], 'stale': data['elsewhere_stale'], 'yaml': data['yaml']}))",
      ].join("\n")
    );
    expect(r.keys).toEqual(["branch", "elsewhere", "elsewhere_available", "elsewhere_partial", "elsewhere_stale", "index", "worktrees", "yaml"]);
    expect(r.branch).toBe("main");
    expect(r.elsewhere.map((e: any) => e.id)).toEqual(["orch-o"]);
    expect(r.partial).toBe(false);
    expect(r.available).toBe(true);
    expect(r.stale).toBe(false); // a primeira consulta (cache frio) roda o comando e devolve o valor em dia
    expect(r.yaml).toMatch(/api-a/);
    expect(r.yaml).not.toMatch(/orch-o/); // a visão local não mistura o que não está mergeado
  });

  // A UI mostra "agregação indisponível" só com `elsewhere_available: false`: sem o comando, o
  // /api/state tem de dizer isso (e não só mandar a lista vazia, igual a "nada em outras branches").
  it("/api/state diz elsewhere_available: false quando o comando beads não roda", { timeout: 120_000 }, () => {
    sb = makeSandbox({ branch: "main" });
    const s = sb;
    s.remove("aiteam/scripts/beads.mjs");
    const r = board(
      s.dir,
      [
        "import socketserver, threading, urllib.request",
        "server.REPO_ROOT = root",
        "server.YAML_PATH = root / '.beads' / 'active.yaml'",
        "server.INDEX_PATH = root / '.beads' / 'index.yaml'",
        "server.LEGACY_INDEX_PATH = root / '.beads' / 'archive' / 'index.yaml'",
        "httpd = socketserver.TCPServer(('127.0.0.1', 0), server.Handler)",
        "threading.Thread(target=httpd.serve_forever, daemon=True).start()",
        "data = json.loads(urllib.request.urlopen('http://127.0.0.1:%d/api/state' % httpd.server_address[1], timeout=60).read())",
        "httpd.shutdown()",
        "print(json.dumps({'elsewhere': data['elsewhere'], 'available': data['elsewhere_available'], 'partial': data['elsewhere_partial']}))",
      ].join("\n")
    );
    expect(r).toEqual({ elsewhere: [], available: false, partial: false });
  });

  it("HEAD destacado aparece como tal; modelo antigo não é regenerado", { timeout: 120_000 }, () => {
    sb = makeSandbox();
    const s = sb;
    s.write(".beads/active.yaml", 'version: "1.0"\ntasks: []\n');
    s.git("add", "-A");
    s.git("commit", "-q", "-m", "legado");
    s.git("checkout", "-q", "--detach");
    const r = board(s.dir, "print(json.dumps({'stale': server.views_stale(root), 'branch': server.current_branch(root)}))");
    expect(r.stale).toBe(false);
    expect(r.branch).toMatch(/^HEAD destacado [0-9a-f]{7}$/);
  });
});
