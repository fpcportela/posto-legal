import atexit
import http.server
import socketserver
import json
import subprocess
import os
import pathlib
import shutil
import threading
import time

PORT = 8080


def _repo_root():
    here = pathlib.Path(__file__).resolve().parent
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(here), capture_output=True, text=True, check=True,
        ).stdout.strip()
        if top:
            return pathlib.Path(top).resolve()
    except Exception:
        pass
    # aiteam/tools/bead_board/server.py → host repo root is 4 levels up.
    return pathlib.Path(__file__).resolve().parents[3]


REPO_ROOT = _repo_root()
YAML_PATH = REPO_ROOT / ".beads" / "active.yaml"
INDEX_PATH = REPO_ROOT / ".beads" / "index.yaml"
# Modelo antigo (antes de migrar): o índice versionado em archive/.
LEGACY_INDEX_PATH = REPO_ROOT / ".beads" / "archive" / "index.yaml"


# ── Visões geradas (aiteam/docs/beads-schema.md §7) ──────────────────────────
# active.yaml e index.yaml são gerados a partir de .beads/tasks/ pelos hooks
# git. Quem edita um bead à mão e abre o board sem passar por um hook veria a
# visão velha, então o board regenera quando a fonte é mais nova que a visão.

def _newest_source_mtime(root):
    beads = root / ".beads"
    newest = 0.0
    for sub in ("tasks", "project"):
        base = beads / sub
        if not base.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            newest = max(newest, os.path.getmtime(dirpath))
            for name in filenames:
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, name)))
    for extra in (beads / "session.local.json", root / "SPEC.md"):
        if extra.exists():
            newest = max(newest, extra.stat().st_mtime)
    return newest


def views_stale(root):
    """True quando a fonte do .beads é mais nova que alguma das duas visões."""
    beads = root / ".beads"
    if not (beads / "tasks").is_dir() and not (beads / "project").is_dir():
        return False  # modelo antigo, ou projeto sem bead: nada a gerar
    active = beads / "active.yaml"
    index = beads / "index.yaml"
    if not active.exists() or not index.exists():
        return True
    return _newest_source_mtime(root) > min(active.stat().st_mtime, index.stat().st_mtime)


def regenerate_views(root, node=None, timeout=10):
    """Roda beads-views.mjs. argv fixo, sem shell e com timeout."""
    node = node or shutil.which("node")
    script = root / "aiteam" / "scripts" / "beads-views.mjs"
    if not node or not script.exists():
        return False
    try:
        result = subprocess.run(
            [node, str(script), "--quiet"],
            cwd=str(root), capture_output=True, text=True, timeout=timeout,
        )
        return result.returncode == 0
    except Exception:
        return False


# ── Outras branches e worktrees (aiteam/docs/beads-schema.md §13) ────────────
# O que outra branch ou worktree fez nos beads e ainda não foi mergeado não
# está nas visões (são só desta árvore). O board pede ao comando `beads`, que
# lê isso do git sob demanda, e mostra como "não mergeado". O Kanban consulta
# /api/state a cada 2 s: o resultado fica em cache por ELSEWHERE_TTL segundos.
#
# O servidor é de uma thread só (socketserver.TCPServer) e o comando leva ~2 s
# com 600 beads. Rodá-lo dentro do pedido travava o board inteiro a cada
# renovação, então o cache vencido NÃO espera: serve o último valor, marcado
# como velho (`stale`), e renova numa thread de fundo (uma por vez). Só a
# primeira consulta, sem valor nenhum para servir, roda o comando no pedido.

ELSEWHERE_TTL = 15.0
# O `beads status` tem prazo interno de 15 s (AGGREGATE_DEADLINE_MS em beads-cmd.mjs) e, estourado,
# devolve `partial: true` com o que leu. O servidor só o mata acima disso: com 10 s o parcial por
# prazo nunca chegava à UI e uma execução lenta virava "indisponível". Como a renovação é em
# segundo plano, esperar mais não trava ninguém (só a 1ª consulta, a frio, espera no pedido —
# e o `__main__` a antecipa).
ELSEWHERE_TIMEOUT = 20
_elsewhere_cache = {"at": None, "root": None, "value": None, "refreshing": False}
_elsewhere_lock = threading.Lock()  # protege o dict acima; seções curtas, nunca segura durante o comando
_elsewhere_compute = threading.Lock()  # no máximo um `beads status` por vez


def _no_elsewhere(available):
    return {"elsewhere": [], "partial": False, "available": available}


# O comando roda numa thread daemon de fundo. No Ctrl+C ou no shutdown a thread morre e o timeout
# com ela: o node filho ficaria órfão até acabar sozinho. Por isso o filho em andamento fica
# guardado e o atexit o mata. (Só o node: os git que ele abriu acabam sozinhos, em ms, e o
# próprio `beads` tem prazo.)
_children = set()
_children_lock = threading.Lock()
_closing = False


def _run_command(argv, cwd, timeout):
    """Como subprocess.run(capture_output=True, timeout=...), guardando o filho em andamento."""
    with subprocess.Popen(
        argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as proc:
        with _children_lock:
            if _closing:  # o servidor já está saindo: não deixa um filho novo nascer
                proc.kill()
            _children.add(proc)
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise
        except BaseException:
            proc.kill()
            raise
        finally:
            with _children_lock:
                _children.discard(proc)
    return subprocess.CompletedProcess(argv, proc.returncode, out, err)


def _kill_children():
    """No atexit: mata o comando em andamento, para o filho não ficar órfão."""
    global _closing
    with _children_lock:
        _closing = True
        procs = list(_children)
    for proc in procs:
        try:
            proc.kill()
        except Exception:
            pass


atexit.register(_kill_children)


def _run_beads_status(root, node=None, timeout=None):
    """Roda `beads status --json --quiet`. argv fixo, sem shell e com timeout."""
    timeout = ELSEWHERE_TIMEOUT if timeout is None else timeout
    node = node or shutil.which("node")
    script = root / "aiteam" / "scripts" / "beads.mjs"
    if not node or not script.exists():
        return _no_elsewhere(False)
    try:
        result = _run_command([node, str(script), "status", "--json", "--quiet"], root, timeout)
        if result.returncode != 0:
            return _no_elsewhere(False)
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
    except Exception:
        return _no_elsewhere(False)
    if not isinstance(data, dict):
        return _no_elsewhere(True)
    items = data.get("elsewhere")
    if not isinstance(items, list):
        items = []
    return {"elsewhere": items, "partial": bool(data.get("partial")), "available": True}


def _refresh_elsewhere(key, root, node, timeout, ttl, now):
    """Roda `beads status` e guarda o resultado. Quem espera a vez de outro
    pedido aproveita o que ele guardou em vez de rodar o comando de novo."""
    with _elsewhere_compute:
        if ttl:
            with _elsewhere_lock:
                c = _elsewhere_cache
                if c["root"] == key and c["at"] is not None and now() - c["at"] < ttl:
                    return c["value"]
        value = _run_beads_status(root, node, timeout)
    with _elsewhere_lock:
        _elsewhere_cache.update(at=now(), root=key, value=value)
    return value


def _refresh_in_background(key, root, node, timeout, ttl, now):
    try:
        _refresh_elsewhere(key, root, node, timeout, ttl, now)
    finally:
        # Mesmo se algo inesperado levantar exceção: o cache não fica preso em "renovando".
        with _elsewhere_lock:
            _elsewhere_cache["refreshing"] = False


def elsewhere_state(root, node=None, timeout=None, ttl=None, now=time.monotonic):
    """Os beads de outras branches e worktrees: o valor do cache por `ttl`
    segundos; vencido, o último valor com `stale: True` enquanto uma thread de
    fundo renova. `ttl=0` não usa o cache: roda o comando agora."""
    ttl = ELSEWHERE_TTL if ttl is None else ttl
    key = str(root)
    if ttl:
        with _elsewhere_lock:
            c = _elsewhere_cache
            if c["root"] == key and c["at"] is not None:
                if now() - c["at"] < ttl:
                    return {**c["value"], "stale": False}
                if not c["refreshing"]:
                    c["refreshing"] = True
                    try:
                        threading.Thread(
                            target=_refresh_in_background,
                            args=(key, root, node, timeout, ttl, now),
                            daemon=True,
                        ).start()
                    except Exception:
                        # Sem thread ("can't start new thread"): o flag não pode ficar preso, ou o
                        # cache seria velho para sempre. O pedido recebe o valor velho e o próximo tenta de novo.
                        c["refreshing"] = False
                return {**c["value"], "stale": True}
    # Sem valor para servir (primeira consulta, outra raiz) ou ttl=0: roda aqui.
    return {**_refresh_elsewhere(key, root, node, timeout, ttl, now), "stale": False}


def current_branch(root):
    """A branch do git, na hora; em HEAD destacado, 'HEAD destacado <sha7>'."""
    try:
        # Sem --short: com uma tag de mesmo nome ele devolveria "heads/<branch>".
        sym = subprocess.run(
            ["git", "symbolic-ref", "-q", "HEAD"],
            cwd=str(root), capture_output=True, text=True, timeout=5,
        )
        ref = sym.stdout.strip() if sym.returncode == 0 else ""
        if ref.startswith("refs/heads/"):
            ref = ref[len("refs/heads/"):]
        if ref:
            return ref
        sha = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            cwd=str(root), capture_output=True, text=True, timeout=5,
        )
        if sha.returncode == 0 and sha.stdout.strip():
            return "HEAD destacado " + sha.stdout.strip()
    except Exception:
        pass
    return ""

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Strip query parameters for routing
        base_path = self.path.split('?')[0]
        
        if base_path == '/api/state':
            self.handle_api()
        elif base_path == '/api/docs':
            self.handle_docs()
        elif base_path == '/kanban' or base_path == '/index.html':
            self.serve_file('index.html')
        elif base_path == '/' or base_path == '/room.html':
            self.serve_file('room.html')
        elif base_path == '/panorama' or base_path == '/panorama.html':
            self.serve_file('panorama.html')
        elif base_path.endswith('.png') or base_path.endswith('.jpg') or base_path.endswith('.css') or base_path.endswith('.mjs'):
            self.serve_file(base_path.lstrip('/'))
        else:
            # Fallback to simple http server for assets if needed, or just 404
            self.send_error(404, "Not Found")
            
    def handle_api(self):
        # 1. Get Worktrees
        try:
            result = subprocess.run(
                ['git', 'worktree', 'list'],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                check=True
            )
            worktrees = result.stdout.strip()
        except Exception as e:
            worktrees = f"Error fetching worktrees: {e}"

        # 2. Get YAML content — regenerated first when the source is newer.
        if views_stale(REPO_ROOT):
            regenerate_views(REPO_ROOT)
        yaml_content = ""
        try:
            if YAML_PATH.exists():
                with open(YAML_PATH, 'r', encoding='utf-8') as f:
                    yaml_content = f.read()
            else:
                yaml_content = f"Error: Could not find {YAML_PATH}"
        except Exception as e:
            yaml_content = f"Error reading YAML: {e}"

        # 2b. Index (knowledge base) — optional, may not exist yet.
        index_content = ""
        try:
            index_path = INDEX_PATH if INDEX_PATH.exists() else LEGACY_INDEX_PATH
            if index_path.exists():
                with open(index_path, 'r', encoding='utf-8') as f:
                    index_content = f.read()
        except Exception as e:
            index_content = f"Error reading index: {e}"

        # 2c. Beads de outras branches e worktrees (não mergeado), em cache.
        elsewhere = elsewhere_state(REPO_ROOT)

        # 3. Respond
        response_data = {
            "worktrees": worktrees,
            "yaml": yaml_content,
            "index": index_content,
            "branch": current_branch(REPO_ROOT),
            "elsewhere": elsewhere["elsewhere"],
            "elsewhere_partial": elsewhere["partial"],
            # False: sem node/beads.mjs, o comando falhou ou passou do prazo. A lista vazia
            # de `elsewhere` não distingue isso de "nada em outras branches".
            "elsewhere_available": elsewhere["available"],
            "elsewhere_stale": elsewhere["stale"],
        }
        
        body = json.dumps(response_data).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # Disable caching for realtime updates
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.end_headers()
        
        self.wfile.write(body)

    def handle_docs(self):
        docs = {}
        # SPEC.md stays at the host root; the real README lives in aiteam/.
        sources = {
            'SPEC.md': REPO_ROOT / 'SPEC.md',
            'README.md': REPO_ROOT / 'aiteam' / 'README.md',
        }
        for filename, path in sources.items():
            try:
                if path.exists():
                    with open(path, 'r', encoding='utf-8') as f:
                        docs[filename] = f.read()
                else:
                    docs[filename] = f"Error: Could not find {filename}"
            except Exception as e:
                docs[filename] = f"Error reading {filename}: {e}"

        body = json.dumps(docs).encode('utf-8')
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, filename):
        # Confine served files to this directory — resolve the candidate and
        # reject anything that escapes it via `..` (path traversal, CWE-22).
        base_dir = pathlib.Path(__file__).parent.resolve()
        file_path = (base_dir / filename).resolve()
        if base_dir != file_path and base_dir not in file_path.parents:
            self.send_error(404, "Not Found")
            return
        if not file_path.is_file():
            self.send_error(404, "Not Found")
            return

        try:
            mime_type = 'text/html'
            mode = 'r'
            kwargs = {'encoding': 'utf-8'}
            
            if filename.endswith('.png'):
                mime_type = 'image/png'
                mode = 'rb'
                kwargs = {}
            elif filename.endswith('.jpg') or filename.endswith('.jpeg'):
                mime_type = 'image/jpeg'
                mode = 'rb'
                kwargs = {}
            elif filename.endswith('.css'):
                mime_type = 'text/css'
            elif filename.endswith('.mjs'):
                mime_type = 'text/javascript'

            with open(file_path, mode, **kwargs) as f:
                content = f.read()
                
            if mode == 'r':
                content = content.encode('utf-8')
            
            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, f"Error loading {filename}: {e}")

if __name__ == "__main__":
    # Bind loopback only — the board exposes .beads state, SPEC/README and
    # `git worktree list`; it is a localhost dev tool, not a LAN service.
    socketserver.TCPServer.allow_reuse_address = True
    # Aquece o cache de outras branches em segundo plano: o primeiro pedido, sem
    # valor para servir, rodaria o comando (~2 s) dentro do pedido.
    threading.Thread(target=elsewhere_state, args=(REPO_ROOT,), daemon=True).start()
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Bead Board Server running at http://localhost:{PORT}")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
