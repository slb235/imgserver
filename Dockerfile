FROM node:14-slim

RUN apt-get update && apt-get install curl -y

WORKDIR /app

COPY ["package.json", "package-lock.json*", "./"]

RUN npm install

COPY . .

CMD [ "node", "index.js" ]