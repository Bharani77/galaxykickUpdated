# Use the custom base image
FROM docker.io/node:18-bullseye

# Set the working directory in the container
WORKDIR /galaxybackend

# Install additional required packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    sudo \
    lsof \  
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libnss3 \
    libxss1 \
    libjpeg62-turbo \
    fonts-liberation \
    libappindicator3-1 \
    libv4l-dev \
    libgtk-3-0 \
    libpango1.0-0 \
    libdbus-glib-1-2 \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install ngrok
RUN curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && \
    echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list && \
    apt-get update && apt-get install -y ngrok && \
    rm -rf /var/lib/apt/lists/*

# Install Flask and Flask-CORS
RUN pip3 install flask flask-cors

# Copy your application files into the container
COPY package*.json ./
COPY . .

# Install Puppeteer and its dependencies
RUN npm install puppeteer axios && \
    npx puppeteer install && \
    npx puppeteer browsers install chrome

RUN npm install playwright
RUN npx playwright install-deps
RUN npx playwright install

# Install PM2 globally
RUN npm install -g pm2 && \
    npm install crypto-js

RUN apt-get install jq

EXPOSE 7860
# Command to run the deployment script, then start the Python app
CMD ["sh", "-c", "python3 /galaxybackend/app.py"]
