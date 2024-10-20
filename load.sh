pm2 start test.js --name test.js

sleep 7

pm2 start galaxy.js --name galaxy.js -- "$1" "$2" "$3" "$4" "$5" "$6" "$7"

#pm2 start galaxy.js --name galaxy.js -- "$1" "dw6hdn2xyb" "1600" "1650" "THE_BOT" "THALA"