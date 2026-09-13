#!/usr/bin/env bash
set -euo pipefail

umask 077
mode=${1:---install}
[[ "$mode" == --install || "$mode" == --check ]] || { echo "usage: setup-second-brain-services.sh [--install|--check]" >&2; exit 2; }
package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
service_root=$data_home/pi-overdrive/services
unit_root=$config_home/systemd/user
python_bin=${PI_OVERDRIVE_PYTHON_BIN:-/usr/bin/python3}
model=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
model_manifest=$package_root/config/local-embedding-model.json
openviking_lock=$package_root/services/requirements-openviking.lock.txt
hindsight_lock=$package_root/services/requirements-hindsight.lock.txt
model_repository=$("$python_bin" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["repository"])' "$model_manifest")
model_revision=$("$python_bin" -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["revision"])' "$model_manifest")
model_cache_key=models--${model_repository//\//--}
model_snapshot=$service_root/embeddings/cache/$model_cache_key/snapshots/$model_revision

render_unit() {
  local source=$1 target=$2
  /usr/bin/sed "s|@SERVICE_ROOT@|$service_root|g" "$source" > "$target.tmp"
  /usr/bin/chmod 600 "$target.tmp"
  /usr/bin/mv -fT "$target.tmp" "$target"
}

check_version() {
  local python=$1 package=$2 expected=$3
  "$python" -c 'import importlib.metadata,sys; assert importlib.metadata.version(sys.argv[1]) == sys.argv[2]' "$package" "$expected"
}

lock_matches() {
  local pip=$1 lock=$2 installed expected
  installed=$("$pip" freeze --all 2>/dev/null | LC_ALL=C sort)
  expected=$(LC_ALL=C /usr/bin/sort "$lock")
  [[ "$installed" == "$expected" ]]
}

check_model_snapshot() {
  "$python_bin" - "$model_manifest" "$model_snapshot" <<'PY'
import hashlib,json,pathlib,sys
manifest=json.load(open(sys.argv[1], encoding="utf-8"))
root=pathlib.Path(sys.argv[2]).resolve(strict=True)
repository_root=root.parent.parent.resolve(strict=True)
for name, expected in manifest["files"].items():
    candidate=(root/name).resolve(strict=True)
    if repository_root != candidate and repository_root not in candidate.parents:
        raise SystemExit(f"embedding_model_path_escape:{name}")
    actual=hashlib.sha256(candidate.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"embedding_model_hash_mismatch:{name}")
print(f"Pinned embedding artifact: PASS ({manifest['repository']}@{manifest['revision']})")
PY
}

if [[ "$mode" == --install ]]; then
  /usr/bin/install -d -m 700 "$service_root" "$service_root/embeddings" "$service_root/embeddings/cache" "$service_root/openviking" "$service_root/openviking/data" "$service_root/hindsight" "$service_root/hindsight/home" "$unit_root"
  for name in openviking hindsight; do
    [[ -x "$service_root/$name/venv/bin/python" ]] || "$python_bin" -m venv "$service_root/$name/venv"
  done
  lock_matches "$service_root/openviking/venv/bin/pip" "$openviking_lock" || "$service_root/openviking/venv/bin/pip" install --no-cache-dir --requirement "$openviking_lock"
  lock_matches "$service_root/hindsight/venv/bin/pip" "$hindsight_lock" || "$service_root/hindsight/venv/bin/pip" install --no-cache-dir --requirement "$hindsight_lock"
  PI_OVERDRIVE_MODEL_MANIFEST="$model_manifest" PI_OVERDRIVE_MODEL_CACHE="$service_root/embeddings/cache" PI_OVERDRIVE_MODEL_OFFLINE=${PI_OVERDRIVE_EMBEDDING_OFFLINE_PREPARE:-0} "$service_root/openviking/venv/bin/python" - <<'PY'
import json,os
from huggingface_hub import snapshot_download
manifest=json.load(open(os.environ["PI_OVERDRIVE_MODEL_MANIFEST"], encoding="utf-8"))
snapshot_download(
    repo_id=manifest["repository"],
    revision=manifest["revision"],
    cache_dir=os.environ["PI_OVERDRIVE_MODEL_CACHE"],
    allow_patterns=list(manifest["files"]),
    local_files_only=os.environ["PI_OVERDRIVE_MODEL_OFFLINE"] == "1",
)
PY
  check_model_snapshot
  /usr/bin/install -m 700 "$package_root/services/local_embeddings.py" "$service_root/embeddings/local_embeddings.py"
  HF_HUB_OFFLINE=1 "$service_root/openviking/venv/bin/python" "$service_root/embeddings/local_embeddings.py" --cache-dir "$service_root/embeddings/cache" --model-path "$model_snapshot" --prepare
  "$service_root/openviking/venv/bin/pip" check
  "$service_root/hindsight/venv/bin/pip" check

  "$service_root/openviking/venv/bin/python" - "$service_root/openviking/ov.conf.tmp" "$service_root/openviking/data" <<'PY'
import json,sys
target,workspace=sys.argv[1:]
config={
 "storage":{"workspace":workspace},
 "embedding":{"dense":{"provider":"openai","model":"sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2","api_base":"http://127.0.0.1:1934/v1","dimension":384,"input":"text","encoding_format":"float"},"max_concurrent":2,"max_retries":0,"text_source":"content_only"},
 "vlm":{},"auto_generate_l0":True,"auto_generate_l1":True,"default_search_mode":"fast","enable_watch_scheduler":False,
 "server":{"host":"127.0.0.1","port":1933,"workers":1,"auth_mode":"dev","cors_origins":[],"profile_enabled":False}
}
with open(target,"w",encoding="utf-8") as f: json.dump(config,f,indent=2); f.write("\n")
PY
  /usr/bin/chmod 600 "$service_root/openviking/ov.conf.tmp"
  /usr/bin/mv -fT "$service_root/openviking/ov.conf.tmp" "$service_root/openviking/ov.conf"
  "$service_root/openviking/venv/bin/python" -c 'from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton; OpenVikingConfigSingleton.initialize(config_path=__import__("sys").argv[1])' "$service_root/openviking/ov.conf"

  /usr/bin/tee "$service_root/hindsight/hindsight.env.tmp" >/dev/null <<EOF
HINDSIGHT_API_DATABASE_URL=pg0://pi-overdrive-hindsight
HINDSIGHT_API_DATABASE_SCHEMA=hindsight
HINDSIGHT_API_LLM_PROVIDER=none
HINDSIGHT_API_RETAIN_LLM_PROVIDER=none
HINDSIGHT_API_REFLECT_LLM_PROVIDER=none
HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER=none
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=local-loopback-not-a-secret
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=$model
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://127.0.0.1:1934/v1
HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS=384
HINDSIGHT_API_RERANKER_PROVIDER=rrf
HINDSIGHT_API_ENABLE_DRY_RUN_EXTRACT=false
HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH=false
HINDSIGHT_API_MCP_ENABLED=false
HINDSIGHT_API_ENABLE_OBSERVATIONS=false
HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false
HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks
HINDSIGHT_API_WORKERS=1
HINDSIGHT_API_WORKER_HTTP_PORT=8890
HINDSIGHT_API_DB_POOL_MIN_SIZE=1
HINDSIGHT_API_DB_POOL_MAX_SIZE=4
HINDSIGHT_API_RECALL_MAX_CONCURRENT=2
HINDSIGHT_API_ACCESS_LOG=false
HINDSIGHT_API_LOG_LEVEL=warning
EOF
  /usr/bin/chmod 600 "$service_root/hindsight/hindsight.env.tmp"
  /usr/bin/mv -fT "$service_root/hindsight/hindsight.env.tmp" "$service_root/hindsight/hindsight.env"
  set -a; source "$service_root/hindsight/hindsight.env"; set +a
  HOME="$service_root/hindsight/home" "$service_root/hindsight/venv/bin/python" -c 'from hindsight_api.config import HindsightConfig; HindsightConfig.from_env().validate()'

  for unit in pi-overdrive-embeddings pi-overdrive-openviking pi-overdrive-hindsight; do
    render_unit "$package_root/services/systemd/$unit.service.in" "$unit_root/$unit.service"
  done
  /usr/bin/systemctl --user daemon-reload
fi

check_version "$service_root/openviking/venv/bin/python" openviking 0.4.19
check_version "$service_root/openviking/venv/bin/python" fastembed 0.8.0
check_version "$service_root/hindsight/venv/bin/python" hindsight-api-slim 0.9.2
lock_matches "$service_root/openviking/venv/bin/pip" "$openviking_lock"
lock_matches "$service_root/hindsight/venv/bin/pip" "$hindsight_lock"
check_model_snapshot
HF_HUB_OFFLINE=1 "$service_root/openviking/venv/bin/python" "$service_root/embeddings/local_embeddings.py" --cache-dir "$service_root/embeddings/cache" --model-path "$model_snapshot" --prepare
for required in "$service_root/openviking/ov.conf" "$service_root/hindsight/hindsight.env"; do [[ -f "$required" && ! -L "$required" && $(stat -c '%a' "$required") == 600 ]] || exit 1; done
"$service_root/openviking/venv/bin/python" -c 'from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton; OpenVikingConfigSingleton.initialize(config_path=__import__("sys").argv[1])' "$service_root/openviking/ov.conf"
set -a; source "$service_root/hindsight/hindsight.env"; set +a
HOME="$service_root/hindsight/home" "$service_root/hindsight/venv/bin/python" -c 'from hindsight_api.config import HindsightConfig; HindsightConfig.from_env().validate()'
"$service_root/openviking/venv/bin/pip" check
"$service_root/hindsight/venv/bin/pip" check
for unit in pi-overdrive-embeddings pi-overdrive-openviking pi-overdrive-hindsight; do
  cmp --silent <(/usr/bin/sed "s|@SERVICE_ROOT@|$service_root|g" "$package_root/services/systemd/$unit.service.in") "$unit_root/$unit.service"
  [[ "$unit_root/$unit.service" != *tasso-pi-overdrive* ]]
done
echo "Pi Overdrive local Second Brain service installation: PASS"
