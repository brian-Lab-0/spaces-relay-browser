# Use the official Playwright image — Chromium + all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app
COPY package.json ./
RUN npm install
COPY relay.js ./
EXPOSE 3333
CMD ["node", "relay.js"]
