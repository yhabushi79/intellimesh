FROM python:3.11-slim

# Ansible playbooks SSH into remote RHEL hosts — need ansible-core + SSH client
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-client sshpass && \
    pip install --no-cache-dir ansible-core && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Python deps (cached layer)
COPY ui/requirements.txt /repo/ui/
RUN pip install --no-cache-dir -r /repo/ui/requirements.txt

# Repo-level files the app references via REPO_ROOT (parent of ui/)
COPY ansible.cfg /repo/
COPY inventory/ /repo/inventory/
COPY group_vars/ /repo/group_vars/
COPY templates/ /repo/templates/
COPY playbooks/ /repo/playbooks/
COPY docs/ /repo/docs/

# UI application
COPY ui/ /repo/ui/

# Writable directories for OpenShift's random non-root UID
RUN mkdir -p /repo/ui/data/sessions && chmod -R 777 /repo/ui/data && \
    mkdir -p /home/appuser/.ansible/tmp /home/appuser/.ssh && \
    chmod -R 777 /home/appuser

ENV HOME=/home/appuser
ENV ANSIBLE_LOCAL_TEMP=/home/appuser/.ansible/tmp

RUN chmod +x /repo/ui/docker-entrypoint.sh

EXPOSE 5050

WORKDIR /repo/ui
ENTRYPOINT ["/repo/ui/docker-entrypoint.sh"]
