set -eu
python3 -m pip install --quiet --disable-pip-version-check --index-url https://pypi.org/simple uv==0.9.5
mkdir -p /root/.local/bin
printf 'export PATH="/usr/local/bin:/root/.local/bin:$PATH"\n' > /root/.local/bin/env
uvx --quiet -p 3.13 -w pytest==8.4.1 -w pytest-json-ctrf==0.3.5 pytest --version
