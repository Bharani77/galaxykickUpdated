#!/bin/bash

# Function to kill a process by alias
sudo pm2 stop test_1.js 
sudo pm2 stop galaxy_1.js
sudo pm2 delete test_1.js
sudo pm2 delete galaxy_1.js
sudo kill -9 $(lsof -t -i :8080)