#!/bin/bash

# Function to kill a process by alias
sudo pm2 stop test.js 
sudo pm2 stop galaxy.js
sudo pm2 delete test.js
sudo pm2 delete galaxy.js
sudo kill -9 $(lsof -t -i :8080)