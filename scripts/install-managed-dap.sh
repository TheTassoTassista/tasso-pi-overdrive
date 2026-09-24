#!/usr/bin/env bash
set -euo pipefail
umask 077

package_root=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/..")
runtime_root="$package_root/runtime/dap"
target="$runtime_root/python"
interpreter=/usr/bin/python3.14

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 || ! -x "$interpreter" ]]; then
  echo "Managed debugpy runtime is only pinned for Linux x86_64 and CPython 3.14." >&2
  exit 1
fi
if [[ $("$interpreter" --version) != 'Python 3.14.7' ]]; then
  echo "Pinned CPython version is unavailable." >&2
  exit 1
fi
mkdir -p -- "$runtime_root"
if [[ -L "$runtime_root" || -e "$target" || -L "$target" ]]; then
  echo "Managed DAP target already exists; refusing to overwrite it." >&2
  exit 1
fi
stage=$(mktemp -d "$runtime_root/.install-XXXXXX")
cleanup() {
  if [[ -n "${stage:-}" && -d "$stage" && "$stage" == "$runtime_root"/.install-* ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup EXIT

"$interpreter" -m venv "$stage/venv"
"$stage/venv/bin/pip" install --disable-pip-version-check --no-cache-dir --no-deps --only-binary=:all: --require-hashes --no-compile --target "$stage/site" -r "$package_root/config/dap-requirements.txt"
PYTHONPATH="$stage/site" PYTHONDONTWRITEBYTECODE=1 "$interpreter" -c 'import debugpy; assert debugpy.__version__ == "1.8.22"'
if [[ -n $(find "$stage/site/debugpy" -type l -print -quit) ]]; then
  echo "Managed debugpy wheel contains a symlink; refusing installation." >&2
  exit 1
fi
tree_digest=$(cd "$stage/site" && find debugpy -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [[ "$tree_digest" != 28fd1a1c1eaaa19efc055c51ee576ec9326726fa81ca1c95727383ae42756636 ]]; then
  echo "Managed debugpy module tree does not match reviewed policy." >&2
  exit 1
fi
mv -- "$stage/site" "$target"
echo "Installed pinned debugpy runtime at $target"
