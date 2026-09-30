ARG BASE_IMAGE=alpine:3.22
FROM ${BASE_IMAGE}
RUN if command -v apk >/dev/null; then \
      apk add --no-cache openssh bash zsh coreutils procps; \
    elif command -v apt-get >/dev/null; then \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server bash zsh coreutils procps ca-certificates && rm -rf /var/lib/apt/lists/*; \
    elif command -v dnf >/dev/null; then \
      dnf install -y --allowerasing openssh-server openssh-clients bash zsh coreutils procps-ng shadow-utils && dnf clean all; \
    elif command -v yum >/dev/null; then \
      rm -f /etc/yum.repos.d/CentOS-*.repo && \
      if [ "$(uname -m)" = aarch64 ]; then archive=altarch/7.9.2009; key=CentOS-7-aarch64; else archive=7.9.2009; key=CentOS-7; fi && \
      printf '[vault]\nname=CentOS 7 archive\nbaseurl=https://vault.centos.org/%s/os/$basearch/\nenabled=1\ngpgcheck=1\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-%s\n' "$archive" "$key" > /etc/yum.repos.d/passport-vault.repo && \
      yum install -y openssh-server openssh-clients bash zsh coreutils procps-ng shadow-utils && yum clean all; \
    else exit 1; fi
RUN if command -v adduser >/dev/null && command -v apk >/dev/null; then adduser -D -s /bin/bash passport; else useradd -m -s /bin/bash passport; fi \
    && mkdir -p /run/sshd /home/passport/.ssh \
    && chmod 700 /home/passport/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /usr/local/bin/passport-test-start
RUN sed -i 's/\r$//' /usr/local/bin/passport-test-start /etc/ssh/sshd_config && chmod 755 /usr/local/bin/passport-test-start
EXPOSE 22
CMD ["/usr/local/bin/passport-test-start"]
