var EventEmitter = require('events').EventEmitter,
  util = require('util'),
  spawn = require('child_process').spawn,
  http = require('http');
const Fs = require('fs');
const Sox = require('sox-stream');
const Ds = require("deepspeech");
const ArgumentParser = require('argparse').ArgumentParser;
const MemoryStream = require('memory-stream');
let model;

function setModel(m) {
  model = m;
}

function getModel() {
  return model;
}

function totalTime(hrtimeValue) {
  return (hrtimeValue[0] + hrtimeValue[1] / 1000000000).toPrecision(4);
}

var Speakable = function Speakable(credentials, options) {
  EventEmitter.call(this);

  options = options || {}

  this.recBuffer = [];
  this.recRunning = false;
  this.apiResult = {};
  this.apiLang = options.lang || "en-US";
  this.apiKey = credentials.key
  this.cmd = options.sox_path || __dirname + '/sox';
  this.cmdArgs = [
    '-q',
    '-b', '16',
    '-d', '-t', 'flac', '-',
    'rate', '16000', 'channels', '1',
    'silence', '1', '0.1', (options.threshold || '0.1') + '%', '1', '1.0', (options.threshold || '0.1') + '%'
  ];
};

util.inherits(Speakable, EventEmitter);
module.exports = Speakable;

Speakable.prototype.postVoiceData = function () {
  var self = this;

  let audioBuffer = self.recBuffer;

  const inference_start = process.hrtime();
  console.error('Running inference.');
  const audioLength = (audioBuffer.length / 2) * (1 / 16000);

  // We take half of the buffer_size because buffer is a char* while
  // LocalDsSTT() expected a short*
  console.log(getModel().stt(audioBuffer.slice(0, audioBuffer.length / 2), 16000));
  const inference_stop = process.hrtime(inference_start);
  console.error('Inference took %ds for %ds audio file.', totalTime(inference_stop), audioLength.toPrecision(4));
};

Speakable.prototype.recordVoice = function () {
  var self = this;

  var rec = spawn(self.cmd, self.cmdArgs, { stdin: 'pipe' });

  // Process stdout

  rec.stdout.on('readable', function () {
    self.emit('speechReady');
  });

  rec.stdout.setEncoding('binary');
  rec.stdout.on('data', function (data) {
    if (!self.recRunning) {
      self.emit('speechStart');
      self.recRunning = true;
    }
    self.recBuffer.push(data);
  });

  // Process stdin

  rec.stderr.setEncoding('utf8');
  rec.stderr.on('data', function (data) {
    console.log(data)
  });

  rec.on('close', function (code) {
    self.recRunning = false;
    if (code) {
      self.emit('error', 'sox exited with code ' + code);
    }
    self.emit('speechStop');
    self.postVoiceData();
  });
};

Speakable.prototype.init = function () {
  return new Promise((resolve, reject) => {
    // These constants control the beam search decoder

    // Beam width used in the CTC decoder when building candidate transcriptions
    const BEAM_WIDTH = 500;

    // These constants are tied to the shape of the graph used (changing them changes
    // the geometry of the first layer), so make sure you use the same constants that
    // were used during training

    // Number of MFCC features to use
    const N_FEATURES = 26;

    // Size of the context window used for producing timesteps in the input vector
    const N_CONTEXT = 9;
    // The alpha hyperparameter of the CTC decoder. Language Model weight
    const LM_WEIGHT = 1.75;

    // The beta hyperparameter of the CTC decoder. Word insertion weight (penalty)
    const WORD_COUNT_WEIGHT = 1.00;

    // Valid word insertion weight. This is used to lessen the word insertion penalty
    // when the inserted word is part of the vocabulary
    const VALID_WORD_COUNT_WEIGHT = 1.00;

    var parser = new ArgumentParser({ addHelp: true });
    let model = process.env.MODEL_PATH;
    let alpha = process.env.ALPHA_PATH;
    let lm = process.env.LANGUAGE_MODEL;
    let trie = process.env.TRIE_PATH;

    console.error('Loading model from file %s', model);
    const model_load_start = process.hrtime();
    setModel(new Ds.Model(model, N_FEATURES, N_CONTEXT, alpha, BEAM_WIDTH));
    const model_load_end = process.hrtime(model_load_start);
    console.error('Loaded model in %ds.', totalTime(model_load_end));

    if (lm && trie) {
      console.error('Loading language model from files %s %s', lm, trie);
      const lm_load_start = process.hrtime();
      getModel().enableDecoderWithLM(alpha, lm, trie,
        LM_WEIGHT, WORD_COUNT_WEIGHT, VALID_WORD_COUNT_WEIGHT);
      const lm_load_end = process.hrtime(lm_load_start);
      console.error('Loaded language model in %ds.', totalTime(lm_load_end));
      return resolve();
    }
    else {
      return reject();
    }
  });
}

Speakable.prototype.resetVoice = function () {
  var self = this;
  self.recBuffer = [];
}

Speakable.prototype.parseResult = function () {
  var recognizedWords = [], apiResult = this.apiResult.result;
  if (apiResult && apiResult.length > 0 && apiResult[0].alternative && apiResult[0].alternative[0]) {
    recognizedWords = apiResult[0].alternative[0].transcript.split(' ');
    this.emit('speechResult', recognizedWords);
  } else {
    this.emit('speechResult', []);
  }
}
