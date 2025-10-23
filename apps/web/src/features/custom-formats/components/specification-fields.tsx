/**
 * Specification Fields Component
 * Dynamically renders input fields for custom format specifications
 * based on field definitions from the schema
 */

"use client";

import { Input } from "../../../components/ui";

interface FieldDefinition {
	order: number;
	name: string;
	label: string;
	value: any;
	type: string;
	advanced?: boolean;
	selectOptions?: Array<{
		value: any;
		name: string;
		order: number;
		dividerAfter?: boolean;
	}>;
	helpText?: string;
	helpTextWarning?: string;
	min?: number;
	max?: number;
	hidden?: string; // Condition for hiding
}

interface SpecificationFieldsProps {
	fields: FieldDefinition[] | Record<string, any>;
	onChange: (fields: Record<string, any>) => void;
}

export function SpecificationFields({ fields, onChange }: SpecificationFieldsProps) {
	// Convert fields to array if it's an object
	const fieldsArray = Array.isArray(fields)
		? fields
		: Object.entries(fields).map(([name, value]) => ({
				name,
				value,
				label: name,
				type: "textbox",
				order: 0,
		  }));

	// Sort by order
	const sortedFields = [...fieldsArray].sort((a, b) => (a.order || 0) - (b.order || 0));

	const handleFieldChange = (fieldName: string, value: any) => {
		// Convert array back to object for storage
		const updatedFields: Record<string, any> = {};

		for (const field of fieldsArray) {
			updatedFields[field.name] = field.name === fieldName ? value : field.value;
		}

		onChange(updatedFields);
	};

	const renderField = (field: FieldDefinition) => {
		switch (field.type) {
			case "select":
				return (
					<select
						value={field.value}
						onChange={(e) => {
							const selectedOption = field.selectOptions?.find(
								(opt) => String(opt.value) === e.target.value
							);
							handleFieldChange(
								field.name,
								selectedOption?.value !== undefined ? selectedOption.value : e.target.value
							);
						}}
						className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
					>
						{field.selectOptions?.map((option) => (
							<option key={option.value} value={option.value}>
								{option.name}
							</option>
						))}
					</select>
				);

			case "number":
				return (
					<Input
						type="number"
						value={field.value || ""}
						onChange={(e) => handleFieldChange(field.name, Number(e.target.value))}
						min={field.min}
						max={field.max}
					/>
				);

			case "textbox":
			case "text":
				return (
					<Input
						type="text"
						value={field.value || ""}
						onChange={(e) => handleFieldChange(field.name, e.target.value)}
					/>
				);

			case "tag":
				return (
					<textarea
						value={field.value || ""}
						onChange={(e) => handleFieldChange(field.name, e.target.value)}
						className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2 resize-none"
						rows={3}
					/>
				);

			default:
				// Fallback for unknown types
				return (
					<Input
						type="text"
						value={String(field.value || "")}
						onChange={(e) => handleFieldChange(field.name, e.target.value)}
					/>
				);
		}
	};

	if (sortedFields.length === 0) {
		return (
			<div className="text-sm text-fg-muted py-2">
				No configurable fields for this specification type.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{sortedFields.map((field) => (
				<div key={field.name} className="space-y-2">
					<label className="text-sm font-medium text-fg">
						{field.label}
						{field.helpText && (
							<span className="ml-2 text-xs text-fg-muted">
								{field.helpText}
							</span>
						)}
					</label>
					{renderField(field)}
					{field.helpTextWarning && (
						<p className="text-xs text-warning">{field.helpTextWarning}</p>
					)}
				</div>
			))}
		</div>
	);
}
