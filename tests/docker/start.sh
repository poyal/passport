#!/bin/sh
set -eu
ssh-keygen -A
printf 'passport:%s\n' "$PASSPORT_TEST_PASSWORD" | chpasswd
printf '%s\n' "$PASSPORT_TEST_PUBLIC_KEY" > /home/passport/.ssh/authorized_keys
chmod 600 /home/passport/.ssh/authorized_keys
chown -R passport:passport /home/passport/.ssh
unset PASSPORT_TEST_PASSWORD PASSPORT_TEST_PUBLIC_KEY
if [ -n "${PASSPORT_TEST_LEGACY_KEX:-}" ]; then
  exec /usr/sbin/sshd -D -e \
    -o "KexAlgorithms=$PASSPORT_TEST_LEGACY_KEX" \
    -o HostKeyAlgorithms=ssh-rsa -o Ciphers=aes128-ctr -o MACs=hmac-sha1
fi
exec /usr/sbin/sshd -D -e
