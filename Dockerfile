# Production image: Next.js standalone server + migrations.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
# VOICE-PRO-04: SaluteSpeech (Sber) serves certificates of the Russian Trusted Root CA, which Node does not
# ship. Fetch it at build time; without it only the Sber voice is unavailable, everything else works.
RUN (wget -qO- https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt; echo; wget -qO- https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt) > /app/russian-ca.pem 2>/dev/null || true
ENV NODE_EXTRA_CA_CERTS=/app/russian-ca.pem
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Migrations run from the same image: `docker compose run --rm migrate`.
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
