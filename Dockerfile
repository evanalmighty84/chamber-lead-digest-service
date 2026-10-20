FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./

RUN npm install \
    --omit=dev \
    --no-audit \
    --no-fund

COPY chamber_classify.js ./
COPY chamber_lead_digest.js ./
COPY lead_types.js ./
COPY run_chamber_daily.js ./

RUN chown -R node:node /app

USER node

CMD ["node", "run_chamber_daily.js"]
