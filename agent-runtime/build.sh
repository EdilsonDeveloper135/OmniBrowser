#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "$0")" && pwd)"
requested_arch="${OMNIBROWSER_AGENT_ARCH:-$(uname -m)}"
case "$requested_arch" in
  arm64|aarch64) artifact_arch="arm64" ;;
  x64|x86_64|amd64) artifact_arch="x64" ;;
  *)
    echo "Unsupported agent sidecar architecture: $requested_arch" >&2
    exit 2
    ;;
esac

python_command="${OMNIBROWSER_AGENT_PYTHON:-python3.12}"
if ! command -v "$python_command" >/dev/null 2>&1; then
  echo "Python 3.12 is required to build the sidecar. Set OMNIBROWSER_AGENT_PYTHON to its executable." >&2
  exit 2
fi

python_version="$($python_command -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$python_version" != "3.12" ]]; then
  echo "The sidecar must be built with Python 3.12; found $python_version." >&2
  exit 2
fi

venv_dir="${OMNIBROWSER_AGENT_VENV:-$runtime_dir/.venv-$artifact_arch}"
# Output locations can move out of the repository, for example when it lives in a synced folder.
dist_root="${OMNIBROWSER_AGENT_DIST_DIR:-$runtime_dir/dist}"
work_root="${OMNIBROWSER_AGENT_WORK_DIR:-$runtime_dir/build}"
if [[ ! -x "$venv_dir/bin/python" ]]; then
  "$python_command" -m venv "$venv_dir"
fi

"$venv_dir/bin/python" -m pip install \
  --disable-pip-version-check \
  --requirement "$runtime_dir/requirements.lock"

rm -rf "$work_root/$artifact_arch" "$dist_root/$artifact_arch/agent-host"
mkdir -p "$work_root/$artifact_arch" "$dist_root/$artifact_arch"
"$venv_dir/bin/python" -m PyInstaller \
  --clean \
  --noconfirm \
  --distpath "$dist_root/$artifact_arch" \
  --workpath "$work_root/$artifact_arch" \
  "$runtime_dir/agent_host.spec"

executable="$dist_root/$artifact_arch/agent-host/agent-host"
if [[ ! -x "$executable" ]]; then
  echo "PyInstaller did not produce the expected onedir executable: $executable" >&2
  exit 1
fi

binary_description="$(/usr/bin/file -b "$executable")"
if [[ "$artifact_arch" == "arm64" && "$binary_description" != *"arm64"* ]]; then
  echo "Expected an arm64 executable, got: $binary_description" >&2
  exit 1
fi
if [[ "$artifact_arch" == "x64" && "$binary_description" != *"x86_64"* ]]; then
  echo "Expected an x86_64 executable, got: $binary_description" >&2
  exit 1
fi

"$executable" --self-check
echo "Built $executable ($binary_description)" >&2
