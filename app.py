from flask import Flask, request, jsonify
import subprocess
import json
import os
import time
import signal
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

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
    with open(f'config{form_number}.json', 'w') as f:
        json.dump(config, f)

def start_test_js(form_number):
    global test_processes
    if not test_processes[form_number] or test_processes[form_number].poll() is not None:
        test_processes[form_number] = subprocess.Popen(['node', f'test_{form_number}.js'])
    time.sleep(5)  # Give some time for the WebSocket server to start

@app.route('/start/<int:form_number>', methods=['POST'])
def start_galaxy(form_number):
    global galaxy_processes
    data = request.json
    write_config(data, form_number)
    
    # Start test.js if it's not already running
    start_test_js(form_number)
    
    if not galaxy_processes[form_number] or galaxy_processes[form_number].poll() is not None:
        # Start galaxy.js with arguments
        args = ['node', f'galaxy_{form_number}.js']
        for key, value in data.items():
            base_key = key.rstrip('12')  # Remove the form number from the key
            if base_key != 'Rival':
                args.extend([f'--{base_key}', str(value)])
            else:
                args.extend([f'--{base_key}', value])
        
        galaxy_processes[form_number] = subprocess.Popen(args)
    
    return jsonify({"message": f"Test_{form_number}.js and Galaxy_{form_number}.js started successfully"}), 200

@app.route('/update/<int:form_number>', methods=['POST'])
def update_galaxy(form_number):
    data = request.json
    write_config(data, form_number)
    return jsonify({"message": f"Galaxy_{form_number}.js config updated successfully"}), 200

@app.route('/stop/<int:form_number>', methods=['POST'])
def stop_galaxy(form_number):
    global galaxy_processes, test_processes
    if galaxy_processes[form_number]:
        galaxy_processes[form_number].terminate()
        galaxy_processes[form_number] = None
    if test_processes[form_number]:
        test_processes[form_number].terminate()
        test_processes[form_number] = None
    
    # Execute killNode.sh
    try:
        subprocess.run(['bash', f'killNode_{form_number}.sh'], check=True)
        return jsonify({"message": f"Galaxy_{form_number}.js and Test_{form_number}.js stopped successfully, and killNode_{form_number}.sh executed"}), 200
    except subprocess.CalledProcessError as e:
        return jsonify({"message": f"Error executing killNode_{form_number}.sh: {str(e)}"}), 500

def cleanup():
    for form_number in [1, 2, 3, 4, 5]:
        if galaxy_processes[form_number]:
            galaxy_processes[form_number].terminate()
        if test_processes[form_number]:
            test_processes[form_number].terminate()
        # Execute killNode.sh during cleanup as well
        subprocess.run([f'bash', f'killNode_{form_number}.sh'], check=False)

if __name__ == '__main__':
    # Register cleanup function to be called on exit
    signal.signal(signal.SIGINT, lambda s, f: cleanup())
    
    # Start test.js for both forms when the Flask app starts
    for form_number in [1, 2, 3, 4, 5]:
        start_test_js(form_number)
    
    app.run(host='0.0.0.0', port=5000)