# Image oficial Playwright jammy (incluye browsers + deps del sistema).
# Referencia: https://playwright.dev/docs/docker
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Dependencias primero — cache de capas.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código.
COPY index.js ./

ENV NODE_ENV=production
ENV PORT=3018

EXPOSE 3018

CMD ["node", "index.js"]