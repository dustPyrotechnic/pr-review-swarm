export function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

// Legacy code — this file was only touched to add the new formatDate above.
// The function below is unchanged and predates this PR.
export function parseUserInput(input: string): any {
    return eval(input);
}


export function slugify(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
