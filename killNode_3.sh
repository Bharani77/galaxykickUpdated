#!/bin/bash

# Function to kill a process by alias
sudo pm2 stop test_3.js 
sudo pm2 stop galaxy_3.js
sudo pm2 delete test_3.js
sudo pm2 delete galaxy_3.js
sudo kill -9 $(lsof -t -i :8082)