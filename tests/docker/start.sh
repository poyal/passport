#!/bin/sh
set -eu
ssh-keygen -A
printf 'passport:%s\n' "$PASSPORT_TEST_PASSWORD" | chpasswd
printf '%s\n' "$PASSPORT_TEST_PUBLIC_KEY" > /home/passport/.ssh/authorized_keys
chmod 600 /home/passport/.ssh/authorized_keys
chown -R passport:passport /home/passport/.ssh
unset PASSPORT_TEST_PASSWORD PASSPORT_TEST_PUBLIC_KEY
exec /usr/sbin/sshd -D -e
