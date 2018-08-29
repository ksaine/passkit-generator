const schema = require("./schema");

/**
 * Pass fields area to be used as pass lower level keys
 * @see https://apple.co/2wkUBd
 */

class FieldsContainer {
	constructor() {
		this.uniqueKeys = [];
		this.fields = [];
	}

	/**
	 * A wrapper of Array.prototype.push to validate the pushed content with the schema.
	 * Accepts also one array of objects.
	 *
	 * @method push
	 * @params {Object[]} fields - the fields to be checked and pushed
	 * @params {schema.constants.field} fields[].* - each key must be compliant with schema.constants.field structure
	 * @returns {Number} - the amount of pushed elements (for checks)
	 */

	push(...fields) {
		if (fields[0] instanceof Array && fields[0].length) {
			fields = fields[0];
		}

		let validFields = fields.filter(f => {
			if (this.uniqueKeys.includes(f.key)) {
				return false;
			}

			this.uniqueKeys.push(f.key);

			return typeof f === "object" && schema.isValid(f, "field");
		});

		this.fields.push(...validFields);

		return validFields.length;
	}

	/**
	 * A wrapper of Array.prototype.pop and Array.prototype.slice to pop
	 * last element or n elements starting from the end.
	 *
	 * @method pop
	 * @params {Number} [quantity=-1] - the amount of elements to be removed
	 * @returns {Number} - the amount of removed elements
	 */

	pop(quantity = -1) {
		if (!this.fields.length) {
			return undefined;
		}

		if (quantity > -1) {
			let removedElements = this.fields.slice(quantity);
			this.fields = this.fields.slice(0, this.fields.length - quantity);
			this.uniqueKeys = this.uniqueKeys.slice(0, this.uniqueKeys - quantity);

			return removedElements;
		}

		this.uniqueKeys.pop();
		return this.fields.pop();
	}
}

module.exports = {
	areas: ["primaryFields", "secondaryFields", "auxiliaryFields", "backFields", "headerFields"],
	FieldsContainer
};
