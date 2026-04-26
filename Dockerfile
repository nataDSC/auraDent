FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra ./infra
COPY docs ./docs
COPY README.md ./

RUN npm install
RUN npm run build --workspace @auradent/web

COPY deploy/huggingface/nginx.conf /etc/nginx/nginx.conf
COPY deploy/huggingface/start-space.sh /usr/local/bin/start-space.sh

RUN chmod +x /usr/local/bin/start-space.sh \
  && rm -rf /usr/share/nginx/html/* \
  && cp -r /app/apps/web/dist/* /usr/share/nginx/html/

ENV PORT=8787
ENV HF_SPACE_PORT=7860

EXPOSE 7860

CMD ["/usr/local/bin/start-space.sh"]
