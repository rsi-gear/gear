set -eu
mkdir -p /app/ssl
openssl genrsa -out /app/ssl/server.key 2048
chmod 600 /app/ssl/server.key
openssl req -new -x509 -sha256 -key /app/ssl/server.key -days 365 -out /app/ssl/server.crt -subj '/O=DevOps Team/CN=dev-internal.company.local'
cat /app/ssl/server.key /app/ssl/server.crt > /app/ssl/server.pem
openssl x509 -in /app/ssl/server.crt -noout -subject -dates -sha256 -fingerprint > /app/ssl/verification.txt
cat > /app/check_cert.py <<'CERT_PY'
import datetime
import pathlib
import ssl

path = pathlib.Path('/app/ssl/server.crt')
assert path.is_file(), 'Certificate does not exist'
cert = ssl._ssl._test_decode_cert(str(path))
subject = dict(item for group in cert['subject'] for item in group)
cn = subject['commonName']
expiry = datetime.datetime.strptime(cert['notAfter'], '%b %d %H:%M:%S %Y %Z')
assert cn == 'dev-internal.company.local'
print('Common Name:', cn)
print('Expiration date:', expiry.date().isoformat())
print('Certificate verification successful')
CERT_PY
python3 /app/check_cert.py
openssl verify -CAfile /app/ssl/server.crt /app/ssl/server.crt
stat -c '%a %n' /app/ssl/server.key
cat /app/ssl/verification.txt
