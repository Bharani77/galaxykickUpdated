#!/bin/bash

# Function to kill a process by alias
sudo pm2 stop test_5.js 
sudo pm2 stop galaxy_5.js
sudo pm2 delete test_5.js
sudo pm2 delete galaxy_5.js
sudo kill -9 $(lsof -t -i :8084)