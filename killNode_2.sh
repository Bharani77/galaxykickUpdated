#!/bin/bash

# Function to kill a process by alias
sudo pm2 stop test_2.js 
sudo pm2 stop galaxy_2.js
sudo pm2 delete test_2.js
sudo pm2 delete galaxy_2.js
sudo kill -9 $(lsof -t -i :8081)