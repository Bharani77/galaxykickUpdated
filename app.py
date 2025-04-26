from flask import Flask, request, jsonify
import subprocess
import json
import os
import time
import signal
from flask_cors import CORS
import pathlib
import re

app = Flask(__name__)
CORS(app)

# Set base path for galaxy backend files
GALAXY_BACKEND_PATH = "/galaxybackend"

galaxy_processes = {1: None, 2: None, 3: None, 4: None, 5: None}

def write_config(data, form_number):
    config = {
        "RC": data[f'RC{form_number}'],
        "startAttackTime": int(data[f'startAttackTime{form_number}']),
        "stopAttackTime": int(data[f'stopAttackTime{form_number}']),
        "attackIntervalTime": int(data[f'attackIntervalTime{form_number}']),
        "startDefenceTime": int(data[f'startDefenceTime{form_number}']),
        "stopDefenceTime": int(data[f'stopDefenceTime{form_number}']),
        "defenceIntervalTime": int(data[f'defenceIntervalTime{form_number}']),
        "planetName": data[f'PlanetName{form_number}'],
        "rival": data[f'Rival{form_number}'].split(',')
    }
    config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
    with open(config_path, 'w') as f:
        json.dump(config, f)

@app.route('/start/<int:form_number>', methods=['POST'])
def start_galaxy(form_number):
    global galaxy_processes
    data = request.json
    write_config(data, form_number)
    
    galaxy_script_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
    if not os.path.exists(galaxy_script_path):
        return jsonify({"error": f"Galaxy script not found: {galaxy_script_path}"}), 404
    
    if not galaxy_processes[form_number] or galaxy_processes[form_number].poll() is not None:
        # Start galaxy.js with PM2 and arguments
        args = ['pm2', 'start', galaxy_script_path]
        
        # Map config fields to command line arguments
        arg_mapping = {
            'RC': 'RC',
            'startAttackTime': 'startAttackTime',
            'stopAttackTime': 'stopAttackTime',
            'attackIntervalTime': 'attackIntervalTime',
            'startDefenceTime': 'startDefenceTime',
            'stopDefenceTime': 'stopDefenceTime',
            'defenceIntervalTime': 'defenceIntervalTime',
            'PlanetName': 'planetName',
            'Rival': 'rival'
        }

        # Add -- to specify arguments for the script
        args.append('--')
        
        for key, value in data.items():
            base_key = key.rstrip('12345')
            if base_key in arg_mapping:
                if base_key == 'Rival':
                    args.extend([f'--{arg_mapping[base_key]}', value])
                else:
                    args.extend([f'--{arg_mapping[base_key]}', str(value)])
        
        galaxy_processes[form_number] = subprocess.Popen(args, cwd=GALAXY_BACKEND_PATH)
    
    return jsonify({
        "message": f"Galaxy_{form_number}.js started successfully",
        "galaxy_pid": galaxy_processes[form_number].pid if galaxy_processes[form_number] else None
    }), 200

@app.route('/update/<int:form_number>', methods=['POST'])
def update_galaxy(form_number):
    data = request.json
    try:
        # Write to the specific config file for this form number
        config = {
            "RC": data[f'RC{form_number}'],
            "startAttackTime": int(data[f'startAttackTime{form_number}']),
            "stopAttackTime": int(data[f'stopAttackTime{form_number}']),
            "attackIntervalTime": int(data[f'attackIntervalTime{form_number}']),
            "startDefenceTime": int(data[f'startDefenceTime{form_number}']),
            "stopDefenceTime": int(data[f'stopDefenceTime{form_number}']),
            "defenceIntervalTime": int(data[f'defenceIntervalTime{form_number}']),
            "planetName": data[f'PlanetName{form_number}'],
            "rival": data[f'Rival{form_number}'].split(',')
        }
        config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
        with open(config_path, 'w') as f:
            json.dump(config, f)
        
        return jsonify({"message": f"Galaxy_{form_number}.js config updated successfully"}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to update config: {str(e)}"}), 500

@app.route('/stop/<int:form_number>', methods=['POST'])
def stop_galaxy(form_number):
    global galaxy_processes
    
    galaxy_pid = galaxy_processes[form_number].pid if galaxy_processes[form_number] else None
    
    if galaxy_processes[form_number]:
        try:
            subprocess.run(['pm2', 'stop', f'galaxy_{form_number}.js'], 
                         cwd=GALAXY_BACKEND_PATH,
                         check=True)
            subprocess.run(['pm2', 'delete', f'galaxy_{form_number}.js'],
                         cwd=GALAXY_BACKEND_PATH,
                         check=True)
            galaxy_processes[form_number] = None
        except subprocess.CalledProcessError as e:
            print(f"Error stopping PM2 process: {e}")
    
    return jsonify({
        "message": f"Galaxy_{form_number}.js stopped successfully",
        "killed_galaxy_pid": galaxy_pid
    }), 200

@app.route('/status', methods=['GET'])
def get_status():
    status = {}
    for form_number in range(1, 6):  # Changed to handle 5 forms
        galaxy_running = galaxy_processes[form_number] is not None and galaxy_processes[form_number].poll() is None
        
        status[f"form_{form_number}"] = {
            "galaxy_running": galaxy_running,
            "galaxy_pid": galaxy_processes[form_number].pid if galaxy_running else None
        }
    
    return jsonify(status), 200

def cleanup():
    for form_number in range(1, 6):  # Changed to handle 5 forms
        try:
            # Stop and delete PM2 processes
            subprocess.run(['pm2', 'stop', f'galaxy_{form_number}.js'], 
                         cwd=GALAXY_BACKEND_PATH,
                         check=True)
            subprocess.run(['pm2', 'delete', f'galaxy_{form_number}.js'],
                         cwd=GALAXY_BACKEND_PATH,
                         check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error stopping PM2 process: {e}")
            continue

if __name__ == '__main__':
    # Register cleanup function to be called on exit
    signal.signal(signal.SIGINT, lambda s, f: cleanup())
    signal.signal(signal.SIGTERM, lambda s, f: cleanup())
    
    # Check if backend directory exists
    if not os.path.exists(GALAXY_BACKEND_PATH):
        print(f"ERROR: Galaxy backend directory not found at {GALAXY_BACKEND_PATH}")
        exit(1)
    
    # Validate all galaxy scripts exist
    missing_files = []
    for form_number in range(1, 6):
        galaxy_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
        if not os.path.exists(galaxy_path):
            missing_files.append(f'galaxy_{form_number}.js')
    
    if missing_files:
        print(f"WARNING: The following files are missing: {', '.join(missing_files)}")
        print("The application will continue, but some functionality may not work.")
    
    app.run(host='0.0.0.0', port=7860)