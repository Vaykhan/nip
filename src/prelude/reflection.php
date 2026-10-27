<?php
// Reflection API (ext/reflection) and the engine attribute classes. Methods delegate to __refl()
// and constructors to __refl_init(), implemented in src/lib/reflection.js.
interface Reflector extends Stringable {
}
class ReflectionException extends Exception {
}
class Reflection {
  public static function getModifierNames(int $modifiers): array {
    $names = [];
    if ($modifiers & 64) $names[] = 'abstract';
    if ($modifiers & 32) $names[] = 'final';
    if ($modifiers & 1) $names[] = 'public';
    elseif ($modifiers & 4) $names[] = 'private';
    elseif ($modifiers & 2) $names[] = 'protected';
    if ($modifiers & 16) $names[] = 'static';
    if ($modifiers & (128 | 65536)) $names[] = 'readonly';
    return $names;
  }
}
abstract class ReflectionFunctionAbstract implements Reflector {
  public string $name;
  private function __clone(): void {}
  public function inNamespace(): bool { return __refl($this, 'inNamespace'); }
  public function isClosure(): bool { return __refl($this, 'isClosure'); }
  public function isDeprecated(): bool { return __refl($this, 'isDeprecated'); }
  public function isInternal(): bool { return __refl($this, 'isInternal'); }
  public function isUserDefined(): bool { return __refl($this, 'isUserDefined'); }
  public function isGenerator(): bool { return __refl($this, 'isGenerator'); }
  public function isVariadic(): bool { return __refl($this, 'isVariadic'); }
  public function isStatic(): bool { return __refl($this, 'isStatic'); }
  public function getClosureThis(): ?object { return __refl($this, 'getClosureThis'); }
  public function getClosureScopeClass(): ?ReflectionClass { return __refl($this, 'getClosureScopeClass'); }
  public function getClosureCalledClass(): ?ReflectionClass { return __refl($this, 'getClosureCalledClass'); }
  public function getClosureUsedVariables(): array { return __refl($this, 'getClosureUsedVariables'); }
  public function getDocComment(): string|false { return __refl($this, 'getDocComment'); }
  public function getEndLine(): int|false { return __refl($this, 'getEndLine'); }
  public function getExtension(): ?ReflectionExtension { return __refl($this, 'getExtension'); }
  public function getExtensionName(): string|false { return __refl($this, 'getExtensionName'); }
  public function getFileName(): string|false { return __refl($this, 'getFileName'); }
  public function getName(): string { return __refl($this, 'getName'); }
  public function getNamespaceName(): string { return __refl($this, 'getNamespaceName'); }
  public function getNumberOfParameters(): int { return __refl($this, 'getNumberOfParameters'); }
  public function getNumberOfRequiredParameters(): int { return __refl($this, 'getNumberOfRequiredParameters'); }
  public function getParameters(): array { return __refl($this, 'getParameters'); }
  public function getShortName(): string { return __refl($this, 'getShortName'); }
  public function getStartLine(): int|false { return __refl($this, 'getStartLine'); }
  public function getStaticVariables(): array { return __refl($this, 'getStaticVariables'); }
  public function returnsReference(): bool { return __refl($this, 'returnsReference'); }
  public function hasReturnType(): bool { return __refl($this, 'hasReturnType'); }
  public function getReturnType(): ?ReflectionType { return __refl($this, 'getReturnType'); }
  public function hasTentativeReturnType(): bool { return __refl($this, 'hasTentativeReturnType'); }
  public function getTentativeReturnType(): ?ReflectionType { return __refl($this, 'getTentativeReturnType'); }
  public function getAttributes(?string $name = NULL, int $flags = 0): array { return __refl($this, 'getAttributes', $name, $flags); }
}
class ReflectionFunction extends ReflectionFunctionAbstract {
  const IS_DEPRECATED = 2048;
  public function __construct(Closure|string $function) { __refl_init($this, 'ReflectionFunction', $function); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function isAnonymous(): bool { return __refl($this, 'isAnonymous'); }
  public function isDisabled(): bool { return __refl($this, 'isDisabled'); }
  public function invoke(mixed ...$args): mixed { return __refl($this, 'invoke', $args); }
  public function invokeArgs(array $args): mixed { return __refl($this, 'invokeArgs', $args); }
  public function getClosure(): Closure { return __refl($this, 'getClosure'); }
}
class ReflectionMethod extends ReflectionFunctionAbstract {
  const IS_STATIC = 16;
  const IS_PUBLIC = 1;
  const IS_PROTECTED = 2;
  const IS_PRIVATE = 4;
  const IS_ABSTRACT = 64;
  const IS_FINAL = 32;
  public string $class;
  public function __construct(object|string $objectOrMethod, ?string $method = NULL) { __refl_init($this, 'ReflectionMethod', $objectOrMethod, $method); }
  public static function createFromMethodName(string $method): static { return new static($method); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function isPublic(): bool { return __refl($this, 'isPublic'); }
  public function isPrivate(): bool { return __refl($this, 'isPrivate'); }
  public function isProtected(): bool { return __refl($this, 'isProtected'); }
  public function isAbstract(): bool { return __refl($this, 'isAbstract'); }
  public function isFinal(): bool { return __refl($this, 'isFinal'); }
  public function isConstructor(): bool { return __refl($this, 'isConstructor'); }
  public function isDestructor(): bool { return __refl($this, 'isDestructor'); }
  public function getClosure(?object $object = NULL): Closure { return __refl($this, 'getClosure', $object); }
  public function getModifiers(): int { return __refl($this, 'getModifiers'); }
  public function invoke(?object $object, mixed ...$args): mixed { return __refl($this, 'invoke', $object, $args); }
  public function invokeArgs(?object $object, array $args): mixed { return __refl($this, 'invokeArgs', $object, $args); }
  public function getDeclaringClass(): ReflectionClass { return __refl($this, 'getDeclaringClass'); }
  public function getPrototype(): ReflectionMethod { return __refl($this, 'getPrototype'); }
  public function hasPrototype(): bool { return __refl($this, 'hasPrototype'); }
  public function setAccessible(bool $accessible): void { __refl($this, 'setAccessible', $accessible); }
}
class ReflectionParameter implements Reflector {
  public string $name;
  private function __clone(): void {}
  public function __construct($function, string|int $param) { __refl_init($this, 'ReflectionParameter', $function, $param); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function getName(): string { return __refl($this, 'getName'); }
  public function isPassedByReference(): bool { return __refl($this, 'isPassedByReference'); }
  public function canBePassedByValue(): bool { return __refl($this, 'canBePassedByValue'); }
  public function getDeclaringFunction(): ReflectionFunctionAbstract { return __refl($this, 'getDeclaringFunction'); }
  public function getDeclaringClass(): ?ReflectionClass { return __refl($this, 'getDeclaringClass'); }
  public function getClass(): ?ReflectionClass { return __refl($this, 'getClass'); }
  public function hasType(): bool { return __refl($this, 'hasType'); }
  public function getType(): ?ReflectionType { return __refl($this, 'getType'); }
  public function isArray(): bool { return __refl($this, 'isArray'); }
  public function isCallable(): bool { return __refl($this, 'isCallable'); }
  public function allowsNull(): bool { return __refl($this, 'allowsNull'); }
  public function getPosition(): int { return __refl($this, 'getPosition'); }
  public function isOptional(): bool { return __refl($this, 'isOptional'); }
  public function isDefaultValueAvailable(): bool { return __refl($this, 'isDefaultValueAvailable'); }
  public function getDefaultValue(): mixed { return __refl($this, 'getDefaultValue'); }
  public function isDefaultValueConstant(): bool { return __refl($this, 'isDefaultValueConstant'); }
  public function getDefaultValueConstantName(): ?string { return __refl($this, 'getDefaultValueConstantName'); }
  public function isVariadic(): bool { return __refl($this, 'isVariadic'); }
  public function isPromoted(): bool { return __refl($this, 'isPromoted'); }
  public function getAttributes(?string $name = NULL, int $flags = 0): array { return __refl($this, 'getAttributes', $name, $flags); }
}
abstract class ReflectionType implements Stringable {
  private function __clone(): void {}
  public function allowsNull(): bool { return __refl($this, 'allowsNull'); }
  public function __toString(): string { return __refl($this, '__toString'); }
}
class ReflectionNamedType extends ReflectionType {
  public function getName(): string { return __refl($this, 'getName'); }
  public function isBuiltin(): bool { return __refl($this, 'isBuiltin'); }
}
class ReflectionUnionType extends ReflectionType {
  public function getTypes(): array { return __refl($this, 'getTypes'); }
}
class ReflectionIntersectionType extends ReflectionType {
  public function getTypes(): array { return __refl($this, 'getTypes'); }
}
class ReflectionClass implements Reflector {
  const IS_IMPLICIT_ABSTRACT = 16;
  const IS_EXPLICIT_ABSTRACT = 64;
  const IS_FINAL = 32;
  const IS_READONLY = 65536;
  public string $name;
  private function __clone(): void {}
  public function __construct(object|string $objectOrClass) { __refl_init($this, 'ReflectionClass', $objectOrClass); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function getName(): string { return __refl($this, 'getName'); }
  public function isInternal(): bool { return __refl($this, 'isInternal'); }
  public function isUserDefined(): bool { return __refl($this, 'isUserDefined'); }
  public function isAnonymous(): bool { return __refl($this, 'isAnonymous'); }
  public function isInstantiable(): bool { return __refl($this, 'isInstantiable'); }
  public function isCloneable(): bool { return __refl($this, 'isCloneable'); }
  public function getFileName(): string|false { return __refl($this, 'getFileName'); }
  public function getStartLine(): int|false { return __refl($this, 'getStartLine'); }
  public function getEndLine(): int|false { return __refl($this, 'getEndLine'); }
  public function getDocComment(): string|false { return __refl($this, 'getDocComment'); }
  public function getConstructor(): ?ReflectionMethod { return __refl($this, 'getConstructor'); }
  public function hasMethod(string $name): bool { return __refl($this, 'hasMethod', $name); }
  public function getMethod(string $name): ReflectionMethod { return __refl($this, 'getMethod', $name); }
  public function getMethods(?int $filter = NULL): array { return __refl($this, 'getMethods', $filter); }
  public function hasProperty(string $name): bool { return __refl($this, 'hasProperty', $name); }
  public function getProperty(string $name): ReflectionProperty { return __refl($this, 'getProperty', $name); }
  public function getProperties(?int $filter = NULL): array { return __refl($this, 'getProperties', $filter); }
  public function hasConstant(string $name): bool { return __refl($this, 'hasConstant', $name); }
  public function getConstants(?int $filter = NULL): array { return __refl($this, 'getConstants', $filter); }
  public function getReflectionConstants(?int $filter = NULL): array { return __refl($this, 'getReflectionConstants', $filter); }
  public function getConstant(string $name): mixed { return __refl($this, 'getConstant', $name); }
  public function getReflectionConstant(string $name): ReflectionClassConstant|false { return __refl($this, 'getReflectionConstant', $name); }
  public function getInterfaces(): array { return __refl($this, 'getInterfaces'); }
  public function getInterfaceNames(): array { return __refl($this, 'getInterfaceNames'); }
  public function isInterface(): bool { return __refl($this, 'isInterface'); }
  public function getTraits(): array { return __refl($this, 'getTraits'); }
  public function getTraitNames(): array { return __refl($this, 'getTraitNames'); }
  public function getTraitAliases(): array { return __refl($this, 'getTraitAliases'); }
  public function isTrait(): bool { return __refl($this, 'isTrait'); }
  public function isEnum(): bool { return __refl($this, 'isEnum'); }
  public function isAbstract(): bool { return __refl($this, 'isAbstract'); }
  public function isFinal(): bool { return __refl($this, 'isFinal'); }
  public function isReadOnly(): bool { return __refl($this, 'isReadOnly'); }
  public function getModifiers(): int { return __refl($this, 'getModifiers'); }
  public function isInstance(object $object): bool { return __refl($this, 'isInstance', $object); }
  public function newInstance(mixed ...$args): object { return __refl($this, 'newInstance', $args); }
  public function newInstanceWithoutConstructor(): object { return __refl($this, 'newInstanceWithoutConstructor'); }
  public function newInstanceArgs(array $args = []): ?object { return __refl($this, 'newInstanceArgs', $args); }
  public function getParentClass(): ReflectionClass|false { return __refl($this, 'getParentClass'); }
  public function isSubclassOf(ReflectionClass|string $class): bool { return __refl($this, 'isSubclassOf', $class); }
  public function getStaticProperties(): array { return __refl($this, 'getStaticProperties'); }
  public function getStaticPropertyValue(string $name, mixed $default = null): mixed { return __refl($this, 'getStaticPropertyValue', ...func_get_args()); }
  public function setStaticPropertyValue(string $name, mixed $value): void { __refl($this, 'setStaticPropertyValue', $name, $value); }
  public function getDefaultProperties(): array { return __refl($this, 'getDefaultProperties'); }
  public function isIterable(): bool { return __refl($this, 'isIterable'); }
  public function isIterateable(): bool { return __refl($this, 'isIterateable'); }
  public function implementsInterface(ReflectionClass|string $interface): bool { return __refl($this, 'implementsInterface', $interface); }
  public function getExtension(): ?ReflectionExtension { return __refl($this, 'getExtension'); }
  public function getExtensionName(): string|false { return __refl($this, 'getExtensionName'); }
  public function inNamespace(): bool { return __refl($this, 'inNamespace'); }
  public function getNamespaceName(): string { return __refl($this, 'getNamespaceName'); }
  public function getShortName(): string { return __refl($this, 'getShortName'); }
  public function getAttributes(?string $name = NULL, int $flags = 0): array { return __refl($this, 'getAttributes', $name, $flags); }
}
class ReflectionObject extends ReflectionClass {
  public function __construct(object $object) { __refl_init($this, 'ReflectionObject', $object); }
}
class ReflectionProperty implements Reflector {
  const IS_STATIC = 16;
  const IS_READONLY = 128;
  const IS_PUBLIC = 1;
  const IS_PROTECTED = 2;
  const IS_PRIVATE = 4;
  public string $name;
  public string $class;
  private function __clone(): void {}
  public function __construct(object|string $class, string $property) { __refl_init($this, 'ReflectionProperty', $class, $property); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function getName(): string { return __refl($this, 'getName'); }
  public function getValue(?object $object = NULL): mixed { return __refl($this, 'getValue', $object); }
  public function setValue(mixed $objectOrValue, mixed $value = null): void { __refl($this, 'setValue', ...func_get_args()); }
  public function isInitialized(?object $object = NULL): bool { return __refl($this, 'isInitialized', $object); }
  public function isPublic(): bool { return __refl($this, 'isPublic'); }
  public function isPrivate(): bool { return __refl($this, 'isPrivate'); }
  public function isProtected(): bool { return __refl($this, 'isProtected'); }
  public function isStatic(): bool { return __refl($this, 'isStatic'); }
  public function isReadOnly(): bool { return __refl($this, 'isReadOnly'); }
  public function isDefault(): bool { return __refl($this, 'isDefault'); }
  public function isPromoted(): bool { return __refl($this, 'isPromoted'); }
  public function getModifiers(): int { return __refl($this, 'getModifiers'); }
  public function getDeclaringClass(): ReflectionClass { return __refl($this, 'getDeclaringClass'); }
  public function getDocComment(): string|false { return __refl($this, 'getDocComment'); }
  public function setAccessible(bool $accessible): void { __refl($this, 'setAccessible', $accessible); }
  public function getType(): ?ReflectionType { return __refl($this, 'getType'); }
  public function hasType(): bool { return __refl($this, 'hasType'); }
  public function hasDefaultValue(): bool { return __refl($this, 'hasDefaultValue'); }
  public function getDefaultValue(): mixed { return __refl($this, 'getDefaultValue'); }
  public function getAttributes(?string $name = NULL, int $flags = 0): array { return __refl($this, 'getAttributes', $name, $flags); }
}
class ReflectionClassConstant implements Reflector {
  const IS_PUBLIC = 1;
  const IS_PROTECTED = 2;
  const IS_PRIVATE = 4;
  const IS_FINAL = 32;
  public string $name;
  public string $class;
  private function __clone(): void {}
  public function __construct(object|string $class, string $constant) { __refl_init($this, 'ReflectionClassConstant', $class, $constant); }
  public function __toString(): string { return __refl($this, '__toString'); }
  public function getName(): string { return __refl($this, 'getName'); }
  public function getValue(): mixed { return __refl($this, 'getValue'); }
  public function isPublic(): bool { return __refl($this, 'isPublic'); }
  public function isPrivate(): bool { return __refl($this, 'isPrivate'); }
  public function isProtected(): bool { return __refl($this, 'isProtected'); }
  public function isFinal(): bool { return __refl($this, 'isFinal'); }
  public function getModifiers(): int { return __refl($this, 'getModifiers'); }
  public function getDeclaringClass(): ReflectionClass { return __refl($this, 'getDeclaringClass'); }
  public function getDocComment(): string|false { return __refl($this, 'getDocComment'); }
  public function getAttributes(?string $name = NULL, int $flags = 0): array { return __refl($this, 'getAttributes', $name, $flags); }
  public function isEnumCase(): bool { return __refl($this, 'isEnumCase'); }
  public function hasType(): bool { return __refl($this, 'hasType'); }
  public function getType(): ?ReflectionType { return __refl($this, 'getType'); }
}
class ReflectionEnum extends ReflectionClass {
  public function __construct(object|string $objectOrClass) { __refl_init($this, 'ReflectionEnum', $objectOrClass); }
  public function hasCase(string $name): bool { return __refl($this, 'hasCase', $name); }
  public function getCase(string $name): ReflectionEnumUnitCase { return __refl($this, 'getCase', $name); }
  public function getCases(): array { return __refl($this, 'getCases'); }
  public function isBacked(): bool { return __refl($this, 'isBacked'); }
  public function getBackingType(): ?ReflectionNamedType { return __refl($this, 'getBackingType'); }
}
class ReflectionEnumUnitCase extends ReflectionClassConstant {
  public function __construct(object|string $class, string $constant) { __refl_init($this, 'ReflectionEnumUnitCase', $class, $constant); }
  public function getEnum(): ReflectionEnum { return __refl($this, 'getEnum'); }
  public function getValue(): UnitEnum { return __refl($this, 'getValue'); }
}
class ReflectionEnumBackedCase extends ReflectionEnumUnitCase {
  public function __construct(object|string $class, string $constant) { __refl_init($this, 'ReflectionEnumBackedCase', $class, $constant); }
  public function getBackingValue(): string|int { return __refl($this, 'getBackingValue'); }
}
class ReflectionAttribute implements Reflector {
  const IS_INSTANCEOF = 2;
  public function getName(): string { return __refl($this, 'getName'); }
  public function getTarget(): int { return __refl($this, 'getTarget'); }
  public function isRepeated(): bool { return __refl($this, 'isRepeated'); }
  public function getArguments(): array { return __refl($this, 'getArguments'); }
  public function newInstance(): object { return __refl($this, 'newInstance'); }
  public function __toString(): string { return __refl($this, '__toString'); }
  private function __clone(): void {}
  public function __construct() { throw new Error('Cannot directly instantiate ReflectionAttribute'); }
}

final class ReflectionReference {
  private function __clone(): void {}
  public function __construct() { throw new Error('Cannot directly instantiate ReflectionReference'); }
  public static function fromArrayElement(array $array, string|int $key): ?ReflectionReference { return __refl_reference($array, $key); }
  public function getId(): string { return __refl($this, 'getId'); }
}
#[Attribute(Attribute::TARGET_CLASS)]
final class Attribute {
  const TARGET_CLASS = 1;
  const TARGET_FUNCTION = 2;
  const TARGET_METHOD = 4;
  const TARGET_PROPERTY = 8;
  const TARGET_CLASS_CONSTANT = 16;
  const TARGET_PARAMETER = 32;
  const TARGET_ALL = 63;
  const IS_REPEATABLE = 64;
  public int $flags;
  public function __construct(int $flags = Attribute::TARGET_ALL) { $this->flags = $flags; }
}
#[Attribute(Attribute::TARGET_METHOD)]
final class ReturnTypeWillChange {
  public function __construct() {}
}
#[Attribute(Attribute::TARGET_CLASS)]
final class AllowDynamicProperties {
  public function __construct() {}
}
#[Attribute(Attribute::TARGET_PARAMETER)]
final class SensitiveParameter {
  public function __construct() {}
}
final class SensitiveParameterValue {
  private readonly mixed $value;
  public function __construct(mixed $value) { $this->value = $value; }
  public function getValue(): mixed { return $this->value; }
  public function __debugInfo(): array { return []; }
}
#[Attribute(Attribute::TARGET_METHOD)]
final class Override {
  public function __construct() {}
}
#[Attribute(Attribute::TARGET_METHOD | Attribute::TARGET_FUNCTION | Attribute::TARGET_CLASS_CONSTANT)]
final class Deprecated {
  public readonly ?string $message;
  public readonly ?string $since;
  public function __construct(?string $message = null, ?string $since = null) { $this->message = $message; $this->since = $since; }
}
#[Attribute(Attribute::TARGET_METHOD | Attribute::TARGET_FUNCTION)]
final class NoDiscard {
  public readonly ?string $message;
  public function __construct(?string $message = null) { $this->message = $message; }
}
class ReflectionExtension implements Reflector {
  public string $name;
  private function __clone(): void {}
  public function __construct(string $name) { __refl_ext_init($this, $name); }
  public function __toString(): string { return "Extension [ <persistent> extension #0 {$this->name} version " . PHP_VERSION . " ] {\n}\n"; }
  public function getName(): string { return $this->name; }
  public function getVersion(): ?string { return PHP_VERSION; }
  public function getFunctions(): array { return []; }
  public function getConstants(): array { return []; }
  public function getINIEntries(): array { return []; }
  public function getClasses(): array { return []; }
  public function getClassNames(): array { return []; }
  public function getDependencies(): array { return []; }
  public function info(): void { echo "\n{$this->name}\n\n"; }
  public function isPersistent(): bool { return true; }
  public function isTemporary(): bool { return false; }
}
