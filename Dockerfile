FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config/punpan_020.control-plane.json ./config/punpan_020.control-plane.json

RUN mkdir -p /app/data \
    && chown -R node:node /app \
    && chmod 0700 /app/data
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONFIG_PATH=/app/config/punpan_020.control-plane.json \
    DATABASE_PATH=/app/data/gmv-max.sqlite
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
