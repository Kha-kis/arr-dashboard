/**
 * Switch Component
 * Simple toggle switch for on/off states
 */

import React from "react";

interface SwitchProps {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
	checked,
	onCheckedChange,
	disabled = false,
	className = "",
}) => {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={`
				relative inline-flex h-6 w-11 items-center rounded-full
				transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2
				${checked ? "bg-primary" : "bg-gray-600"}
				${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
				${className}
			`}
		>
			<span
				className={`
					inline-block h-4 w-4 transform rounded-full bg-white transition-transform
					${checked ? "translate-x-6" : "translate-x-1"}
				`}
			/>
		</button>
	);
};
