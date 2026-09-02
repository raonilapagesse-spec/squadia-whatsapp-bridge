FROM node:20-alpine

# Instala git (necessário para algumas dependências npm)
RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
