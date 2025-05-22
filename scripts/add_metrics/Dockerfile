FROM node:20-bullseye


RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip

RUN pip3 install --no-cache-dir radon black

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

CMD ["npm", "run", "start"]
