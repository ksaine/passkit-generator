const os = require("os");
const fs = require("fs");
const path = require("path");
const forge = require("node-forge");
const { spawn } = require("child_process");
const archiver = require("archiver");
const async = require("async");
const stream = require("stream");

const supportedTypesOfPass = /(boardingPass|eventTicket|coupon|generic|storeCard)/i;
const Certificates = {
	status: false
};

const Configuration = {
	passModelsDir: null,
	output: {
		shouldWrite: false,
		dir: null,
	}
}

/**
	Apply a filter to arg0 to remove hidden files names (starting with dot)
	@function removeHiddenFiles
	@params {[String]} from - list of file names
	@return {[String]}
*/

function removeHiddenFiles(from) {
	return from.filter(e => e.charAt(0) !== ".");
}

function capitalizeFirst(str) {
	return str[0].toUpperCase()+str.slice(1);
}

function loadConfiguration(setup) {
	let reqFilesKeys = ["wwdr", "signerCert", "signerKey"];

	// Node-Forge also accepts .cer certificates
	if (!setup.certificates.dir || fs.accessSync(path.resolve(setup.certificates.dir)) !== undefined) {
		throw new Error("Unable to load certificates directory. Check its existence or the permissions.");
	}

	if (!setup.certificates.files) {
		throw new Error("Expected key 'files' in configuration file but not found.");
	}

	if (!setup.certificates.files.wwdr) {
		throw new Error("Expected file path or content for key certificates.files.wwdr. Please provide a valid certificate from https://apple.co/2sc2pvv");
	}

	if (!setup.certificates.files.signerCert) {
		throw new Error("Expected file path or content for key certificates.files.signerCert. Please provide a valid signer certificate.")
	}

	if (!setup.certificates.files.signerKey || !setup.certificates.credentials.privateKeySecret) {
		throw new Error("Expected file path or content for key certificates.files.signerKey with an associated password at certificates.credentials.privateKeySecret but not found.")
	}

	let certPaths = reqFilesKeys.map(e => path.resolve(setup.certificates.dir, setup.certificates.files[e]));

	return new Promise(function(success, reject) {
		let docStruct = {};

		async.concat(certPaths, fs.readFile, function(err, contents) {
			if (err) {
				return reject(err);
			}

			return success(
				contents.map(function(file, index) {
					if (file.includes("PRIVATE KEY")) {
						return forge.pki.decryptRsaPrivateKey(
							file,
							setup.certificates.credentials.privateKeySecret
						);
					} else if (file.includes("CERTIFICATE")) {
						return forge.pki.certificateFromPem(file);
					} else {
						throw new Error("File not allowed in configuration. Only .pems files containing certificates and private keys are allowed");
					}
				})
			)
		});
	});
}

/**
	Generates the cryptografic signature for the manifest file.
	Spawns Openssl process since Node.js has no support for PKCSs.

	@function createSignature
	@params {String} manifestPath - temp dir path created to keep the manifest file.
	@returns {Object} Promise
*/


function createSignature(manifest) {
	let signature = forge.pkcs7.createSignedData();

	if (typeof manifest === "object") {
		signature.content = forge.util.createBuffer(JSON.stringify(manifest), "utf8")
	} else if (typeof manifest === "string") {
		signature.content = manifest;
	} else {
		throw new Error(`Manifest content must be a string or an object. Unable to accept manifest of type ${typeof manifest}`);
	}

	signature.addCertificate(Certificates.wwdr);
	signature.addCertificate(Certificates.signerCert);

	signature.addSigner({
		key: Certificates.signerKey,
		certificate: Certificates.signerCert,
		digestAlgorithm: forge.pki.oids.sha1,
		authenticatedAttributes: [{
			type: forge.pki.oids.contentType,
			value: forge.pki.oids.data
		}, {
			type: forge.pki.oids.messageDigest,
		}, {
			// the value is autogenerated
			type: forge.pki.oids.signingTime,
		}]
	});

	signature.sign();

	/*
	 * Signing creates in contentInfo a JSON object nested BER/TLV (X.690 standard) structure.
	 * Each object represents a component of ASN.1 (Abstract Syntax Notation)
	 * For a more complete reference, refer to: https://en.wikipedia.org/wiki/X.690#BER_encoding
	 *
	 * signature.contentInfo.type => SEQUENCE OF (16)
	 * signature.contentInfo.value[0].type => OBJECT IDENTIFIER (6)
	 * signature.contantInfo.value[1].type => END OF CONTENT (EOC - 0)
	 *
	 * EOC are only present only in constructed indefinite-length methods
	 * Since `signature.contentInfo.value[1].value` contains an object whose value contains the content we passed,
	 * we have to pop the whole object away to avoid signature content invalidation.
	 *
	 */
	signature.contentInfo.value.pop();

	// Converting the JSON Structure into a DER (which is a subset of BER), ASN.1 valid structure
	// Returning the buffer of the signature

	return Buffer.from(forge.asn1.toDer(signature.toAsn1()).getBytes(), 'binary');
}

/**
	Filters the options received in the query from http request into supported options
	by Apple and this application, based on the functions that can be provided to keys
	in supportedOptions.

	You can create your own function to check if keys in query meet your requirements.
	They accept the value provided in the related query key as unique parameter.
	Make them return a boolean value, true if the requirements are met, false otherwise.

	Example:

	barcode: function _checkBarcode() {
		if ( type of barcode not supported ) {
			return false;
		}

		if ( barcode value doesn't meet your requirements )
			return false;
		}

		return true;
	}

	Please note that some options are not supported since should be included inside the
	models you provide in "passModels" directory.

	@function filterPassOptions
	@params {Object} query - raw informations to be edited in the pass.json file
							from HTTP Request Params or Body
	@returns {Object} - filtered options based on above criterias.
*/

function filterPassOptions(query) {
	const supportedOptions = {
		"serialNumber": null,
		"userInfo": null,
		"expirationDate": null,
		"locations": null,
		"authenticationToken": null,
		"barcode": null
	};

	let options = {};

	Object.keys(supportedOptions).forEach(function(key) {
		if (!!query[key]) {
			if (!supportedOptions[key] || typeof supportedOptions[key] !== "function" || typeof supportedOptions[key] === "function" && supportedOptions[key](query[key])) {
				options[key] = query[key];
			}
		}
	});

	return options;
}

/**
	Edits the buffer of pass.json based on the passed options.

	@function editPassStructure
	@params {Object} options - options resulting from the filtering made by filterPassOptions function
	@params {Buffer} passBuffer - Buffer of the contents of pass.json
	@returns {Promise} - Edited pass.json buffer or Object containing error.
*/

function editPassStructure(options, passBuffer) {
	if (!options) {
		return Promise.resolve(passBuffer);
	}

	return new Promise(function(done, reject) {
		try {
			let passFile = JSON.parse(passBuffer.toString("utf8"));

			for (prop in options) {
				passFile[prop] = options[prop];
			}

			return done(Buffer.from(JSON.stringify(passFile)));
		} catch(e) {
			return reject(e);
		}
	});
}

/**
	Creates a pass with the passed information

	@function generatePass
	@params {Object} options - The options about the model to be used and override pass data,
	@return {Promise} - A JSON structure containing the error or the stream of the generated pass.
*/

function generatePass(options) {
	return new Promise(function(success, reject) {
		if (!options.modelName || typeof options.modelName !== "string") {
			return reject({
				status: false,
				error: {
					message: "A string model name must be provided in order to continue.",
					ecode: 418
				}
			});
		}

		fs.readdir(path.resolve(Configuration.passModelsDir, `${options.modelName}.pass`), function(err, files) {
			if (err) {
				return reject({
					status: false,
					error: {
						message: "Provided model name doesn't match with any model in the folder.",
						ecode: 418
					}
				});
			}

			let list = removeHiddenFiles(files);

			if (!list.length) {
				return reject({
					status: false,
					error: {
						message: "Model provided matched but unitialized. Refer to https://apple.co/2IhJr0Q to fill the model correctly.",
						ecode: 418
					}
				});
			}

			if (!list.includes("pass.json")) {
				return reject({
					status: false,
					error: {
						message: "I'm a teapot. How am I supposed to serve you pass without pass.json in the chosen model as tea without water?",
						ecode: 418
					}
				});
			}

			fs.readFile(path.resolve(Configuration.passModelsDir, `${options.modelName}.pass`, "pass.json"), {}, function _parsePassJSONBuffer(err, passStructBuffer) {
				editPassStructure(filterPassOptions(options.overrides), passStructBuffer)
				.then(function _afterJSONParse(passFileBuffer) {
					let manifest = {};
					let archive = archiver("zip");

					archive.append(passFileBuffer, { name: "pass.json" });

					manifest["pass.json"] = forge.md.sha1.create().update(passFileBuffer.toString("binary")).digest().toHex();

					async.each(list, function getHashAndArchive(file, callback) {
						if (/(manifest|signature|pass)/ig.test(file)) {
							// skipping files
							return callback();
						}

						// adding the files to the zip - i'm not using .directory method because it adds also hidden files like .DS_Store on macOS
						archive.file(`${Configuration.passModelsDir}/${options.modelName}.pass/${file}`, { name: file });

						let hashFlow = forge.md.sha1.create();

						fs.createReadStream(`${Configuration.passModelsDir}/${options.modelName}.pass/${file}`)
						.on("data", function(data) {
							hashFlow.update(data.toString("binary"));
						})
						.on("error", function(e) {
							return callback(e);
						})
						.on("end", function() {
							manifest[file] = hashFlow.digest().toHex().trim();
							return callback();
						});
					}, function end(error) {
						if (error) {
							return reject({
								status: false,
								error: {
									message: `Unable to compile manifest. ${error}`,
									ecode: 418
								}
							});
						}

						archive.append(JSON.stringify(manifest), { name: "manifest.json" });

						let signatureBuffer = createSignature(manifest);
						archive.append(signatureBuffer, { name: "signature" });

						let passStream = new stream.PassThrough();
						archive.pipe(passStream);
						archive.finalize().then(function() {
							return success({
								status: true,
								content: passStream,
							});
						});
					});
				})
				.catch(function(err) {
					return reject({
						status: false,
						error: {
							message: `pass.json Buffer is not a valid buffer. Unable to continue.\n${err}`,
							ecode: 418
						}
					});
				});
			});
		});
	});
}

function init(configPath) {
	if (Certificates.status) {
		throw new Error("Initialization must be triggered only once.");
	}

	if (!configPath || typeof configPath !== "object" || typeof configPath === "object" && !Object.keys(configPath).length) {
		throw new Error(`Cannot initialize PassKit module. Param 0 expects a non-empty configuration object.`);
	}

	let queue = [
		new Promise(function(success, reject) {
			fs.access(path.resolve(configPath.models.dir), function(err) {
				if (err) {
					return reject("A valid pass model directory is required. Please provide one in the configuration file under voice 'models.dir'.")
				}

				return success(true);
			});
		}),
		loadConfiguration(configPath)
	];

	Promise.all(queue)
	.then(function(results) {
		let certs = results[1];

		if (results[0]) {
			Configuration.passModelsDir = configPath.models.dir;
		}

		Certificates.wwdr = certs[0];
		Certificates.signerCert = certs[1];
		Certificates.signerKey = certs[2];
		Certificates.status = true;
	})
	.catch(function(error) {
		throw new Error(error);
	});
}

module.exports = { init, generatePass };
