FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
# `version.json` is stamped in the public mirror at sync time. Copy the
# complete build context so that file reaches this stage when it exists; a
# checkout from before stamping still builds with an empty fallback file.
COPY . ./
RUN npx tsc && { test -f version.json || printf '{}' > version.json; }

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache wget
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/version.json ./
RUN mkdir -p logs
EXPOSE 4000
CMD ["node", "dist/index.js"]
