FROM node:22-alpine AS build-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    rm -rf node_modules/@playwright/test node_modules/playwright node_modules/playwright-core && \
    rm -f node_modules/.bin/playwright

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=build-dependencies /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache font-noto font-noto-cjk tini
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=production-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/worker ./worker
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
RUN mkdir -p /app/.data && chown nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3100
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
