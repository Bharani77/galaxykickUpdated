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
test_processes = {1: None, 2: None, 3: None, 4: None, 5: None}

def write_config(data, form_number):
    config = {
        "RC": data[f'RC{form_number}'],
        "AttackTime": int(data[f'AttackTime{form_number}']),
        "DefenceTime": int(data[f'DefenceTime{form_number}']),
        "planetName": data[f'PlanetName{form_number}'],
        "interval": int(data[f'IntervalTime{form_number}']),
        "rival": data[f'Rival{form_number}'].split(',')
    }
    config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
    with open(config_path, 'w') as f:
        json.dump(config, f)

def start_test_js(form_number):
    global test_processes
    test_script_path = os.path.join(GALAXY_BACKEND_PATH, f'test_{form_number}.js')
    
    if not os.path.exists(test_script_path):
        raise FileNotFoundError(f"Test script not found: {test_script_path}")
        
    if not test_processes[form_number] or test_processes[form_number].poll() is not None:
        test_processes[form_number] = subprocess.Popen(['node', test_script_path], 
                                                      cwd=GALAXY_BACKEND_PATH)
    time.sleep(5)  # Give some time for the WebSocket server to start

@app.route('/start/<int:form_number>', methods=['POST'])
def start_galaxy(form_number):
    global galaxy_processes
    data = request.json
    write_config(data, form_number)
    
    # Start test.js if it's not already running
    try:
        start_test_js(form_number)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    
    galaxy_script_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
    if not os.path.exists(galaxy_script_path):
        return jsonify({"error": f"Galaxy script not found: {galaxy_script_path}"}), 404
    
    if not galaxy_processes[form_number] or galaxy_processes[form_number].poll() is not None:
        # Start galaxy.js with arguments
        args = ['node', galaxy_script_path]
        for key, value in data.items():
            base_key = key.rstrip('12345')  # Remove any form number from the key
            if base_key != 'Rival':
                args.extend([f'--{base_key}', str(value)])
            else:
                args.extend([f'--{base_key}', value])
        
        galaxy_processes[form_number] = subprocess.Popen(args, cwd=GALAXY_BACKEND_PATH)
    
    return jsonify({
        "message": f"Test_{form_number}.js and Galaxy_{form_number}.js started successfully",
        "test_pid": test_processes[form_number].pid if test_processes[form_number] else None,
        "galaxy_pid": galaxy_processes[form_number].pid if galaxy_processes[form_number] else None
    }), 200

@app.route('/update/<int:form_number>', methods=['POST'])
def update_galaxy(form_number):
    data = request.json
    try:
        write_config(data, form_number)
        return jsonify({"message": f"Galaxy_{form_number}.js config updated successfully"}), 200
    except Exception as e:
        return jsonify({"error": f"Failed to update config: {str(e)}"}), 500

@app.route('/stop/<int:form_number>', methods=['POST'])
def stop_galaxy(form_number):
    global galaxy_processes, test_processes
    
    # Store process IDs before termination for reporting
    galaxy_pid = galaxy_processes[form_number].pid if galaxy_processes[form_number] else None
    test_pid = test_processes[form_number].pid if test_processes[form_number] else None
    
    if galaxy_processes[form_number]:
        galaxy_processes[form_number].terminate()
        try:
            galaxy_processes[form_number].wait(timeout=5)
        except subprocess.TimeoutExpired:
            galaxy_processes[form_number].kill()
        galaxy_processes[form_number] = None
    
    if test_processes[form_number]:
        test_processes[form_number].terminate()
        try:
            test_processes[form_number].wait(timeout=5)
        except subprocess.TimeoutExpired:
            test_processes[form_number].kill()
        test_processes[form_number] = None
    
    # Execute killNode.sh but suppress PM2 not found errors
    kill_script_path = os.path.join(GALAXY_BACKEND_PATH, f'killNode_{form_number}.sh')
    if os.path.exists(kill_script_path):
        try:
            # Run the kill script but capture output to filter errors
            process = subprocess.Popen(
                ['bash', kill_script_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=GALAXY_BACKEND_PATH,
                text=True
            )
            stdout, stderr = process.communicate()
            
            # Filter out PM2 "not found" errors from the output
            filtered_stderr = []
            for line in stderr.splitlines():
                if not re.search(r'\[PM2\]\[ERROR\]\s+Process or Namespace .* not found', line):
                    filtered_stderr.append(line)
            
            # If there are real errors after filtering, report them
            if filtered_stderr:
                return jsonify({
                    "message": f"Galaxy_{form_number}.js and Test_{form_number}.js stopped, but with warnings",
                    "warnings": "\n".join(filtered_stderr),
                    "killed_galaxy_pid": galaxy_pid,
                    "killed_test_pid": test_pid
                }), 200
            else:
                return jsonify({
                    "message": f"Galaxy_{form_number}.js and Test_{form_number}.js stopped successfully",
                    "killed_galaxy_pid": galaxy_pid,
                    "killed_test_pid": test_pid
                }), 200
                
        except Exception as e:
            return jsonify({
                "message": f"Error executing killNode_{form_number}.sh, but processes terminated manually: {str(e)}",
                "killed_galaxy_pid": galaxy_pid,
                "killed_test_pid": test_pid
            }), 200
    else:
        return jsonify({
            "message": f"Kill script not found, but processes terminated manually",
            "killed_galaxy_pid": galaxy_pid,
            "killed_test_pid": test_pid
        }), 200

@app.route('/status', methods=['GET'])
def get_status():
    status = {}
    for form_number in range(1, 6):
        galaxy_running = galaxy_processes[form_number] is not None and galaxy_processes[form_number].poll() is None
        test_running = test_processes[form_number] is not None and test_processes[form_number].poll() is None
        
        status[f"form_{form_number}"] = {
            "galaxy_running": galaxy_running,
            "test_running": test_running,
            "galaxy_pid": galaxy_processes[form_number].pid if galaxy_running else None,
            "test_pid": test_processes[form_number].pid if test_running else None
        }
    
    return jsonify(status), 200

def cleanup():
    for form_number in range(1, 6):
        if galaxy_processes[form_number]:
            try:
                galaxy_processes[form_number].terminate()
                galaxy_processes[form_number].wait(timeout=3)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                if galaxy_processes[form_number]:
                    galaxy_processes[form_number].kill()
                
        if test_processes[form_number]:
            try:
                test_processes[form_number].terminate()
                test_processes[form_number].wait(timeout=3)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                if test_processes[form_number]:
                    test_processes[form_number].kill()
        
        # Execute killNode.sh during cleanup but suppress PM2 not found errors
        kill_script_path = os.path.join(GALAXY_BACKEND_PATH, f'killNode_{form_number}.sh')
        if os.path.exists(kill_script_path):
            try:
                # Use DEVNULL to suppress output when we don't need to see it
                subprocess.run(
                    ['bash', kill_script_path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    check=False,
                    cwd=GALAXY_BACKEND_PATH
                )
            except Exception:
                # Just ignore any errors during cleanup
                pass

if __name__ == '__main__':
    # Register cleanup function to be called on exit
    signal.signal(signal.SIGINT, lambda s, f: cleanup())
    signal.signal(signal.SIGTERM, lambda s, f: cleanup())
    
    # Check if backend directory exists
    if not os.path.exists(GALAXY_BACKEND_PATH):
        print(f"ERROR: Galaxy backend directory not found at {GALAXY_BACKEND_PATH}")
        exit(1)
    
    # Validate scripts exist before starting
    missing_files = []
    for form_number in range(1, 6):
        test_path = os.path.join(GALAXY_BACKEND_PATH, f'test_{form_number}.js')
        galaxy_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
        
        if not os.path.exists(test_path):
            missing_files.append(f'test_{form_number}.js')
        if not os.path.exists(galaxy_path):
            missing_files.append(f'galaxy_{form_number}.js')
    
    if missing_files:
        print(f"WARNING: The following files are missing: {', '.join(missing_files)}")
        print("The application will continue, but some functionality may not work.")
    
    # Only attempt to start test.js files that actually exist
    for form_number in range(1, 6):
        test_path = os.path.join(GALAXY_BACKEND_PATH, f'test_{form_number}.js')
        if os.path.exists(test_path):
            try:
                start_test_js(form_number)
                print(f"Started test_{form_number}.js successfully")
            except Exception as e:
                print(f"Failed to start test_{form_number}.js: {str(e)}")
    
    app.run(host='0.0.0.0', port=7860)