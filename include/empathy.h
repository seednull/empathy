#pragma once

#include <stdint.h> // TODO: get rid of this dependency later

// Version
#define EMPATHY_VERSION_MAJOR 1
#define EMPATHY_VERSION_MINOR 0
#define EMPATHY_VERSION_PATCH 0
#define EMPATHY_VERSION "1.0.0-dev"

// Platform specific defines
#if defined(_WIN32)
	#define EMPATHY_EXPORT		__declspec(dllexport)
	#define EMPATHY_IMPORT		__declspec(dllimport)
	#define EMPATHY_INLINE		__forceinline
	#define EMPATHY_RESTRICT	__restrict
#else
	#define EMPATHY_EXPORT		__attribute__((visibility("default")))
	#define EMPATHY_IMPORT
	#define EMPATHY_INLINE		__inline__
	#define EMPATHY_RESTRICT	__restrict
#endif

#if defined(EMPATHY_SHARED_LIBRARY)
	#define EMPATHY_APIENTRY extern EMPATHY_EXPORT
#else
	#define EMPATHY_APIENTRY extern EMPATHY_IMPORT
#endif

#if !defined(EMPATHY_NULL_HANDLE)
	#define EMPATHY_NULL_HANDLE 0
#endif

#define EMPATHY_DEFINE_HANDLE(TYPE) typedef uint64_t TYPE

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handles
EMPATHY_DEFINE_HANDLE(Empathy_Instance);
EMPATHY_DEFINE_HANDLE(Empathy_ProgramLayout);
EMPATHY_DEFINE_HANDLE(Empathy_Program);
EMPATHY_DEFINE_HANDLE(Empathy_Machine);

// Enums
typedef enum Empathy_Result_t
{
	EMPATHY_SUCCESS = 0,
	EMPATHY_EXECUTION_YIELD,
	EMPATHY_EXECUTION_END,
	EMPATHY_NOT_IMPLEMENTED,
	EMPATHY_INVALID_INSTANCE,
	EMPATHY_INVALID_OUTPUT_ARGUMENT,
	EMPATHY_INVALID_INSTRUCTION_OPCODE,
	EMPATHY_INVALID_INSTRUCTION_DATA,
	EMPATHY_INVALID_OPERAND_TYPE,
	EMPATHY_PARAMETER_NOT_READABLE,
	EMPATHY_PARAMETER_NOT_WRITABLE,
	EMPATHY_PARAMETER_TABLE_OUT_OF_BOUNDS_READ,
	EMPATHY_PARAMETER_TABLE_OUT_OF_BOUNDS_WRITE,
	EMPATHY_BASE_TYPE_MISMATCH,
	EMPATHY_ATOM_TYPE_MISMATCH,
	EMPATHY_STACK_OVERFLOW,
	EMPATHY_STACK_UNDERFLOW,
	EMPATHY_INSTRUCTION_LIMIT_EXCEEDED,

	// FIXME: add more error codes for internal errors
	EMPATHY_INTERNAL_ERROR,

	EMPATHY_RESULT_ENUM_MAX,
	EMPATHY_RESULT_ENUM_FORCE32 = 0x7FFFFFFF,
} Empathy_Result;

typedef enum Empathy_ValueBaseType_t
{
	EMPATHY_VALUE_BASE_TYPE_UINT8 = 0,
	EMPATHY_VALUE_BASE_TYPE_UINT16,
	EMPATHY_VALUE_BASE_TYPE_UINT32,
	EMPATHY_VALUE_BASE_TYPE_UINT64,
	EMPATHY_VALUE_BASE_TYPE_INT8,
	EMPATHY_VALUE_BASE_TYPE_INT16,
	EMPATHY_VALUE_BASE_TYPE_INT32,
	EMPATHY_VALUE_BASE_TYPE_INT64,
	EMPATHY_VALUE_BASE_TYPE_FLOAT32,
	EMPATHY_VALUE_BASE_TYPE_FLOAT64,
	EMPATHY_VALUE_BASE_TYPE_ATOM,

	EMPATHY_VALUE_BASE_TYPE_ENUM_MAX,
	EMPATHY_VALUE_BASE_TYPE_ENUM_FORCE32 = 0x7FFFFFFF,
} Empathy_ValueBaseType;

typedef enum Empathy_ParameterAccessFlags_t
{
	EMPATHY_PARAMETER_ACCESS_FLAGS_READ = 0x00000001,
	EMPATHY_PARAMETER_ACCESS_FLAGS_WRITE = 0x00000002,
	EMPATHY_PARAMETER_ACCESS_FLAGS_READ_WRITE = 0x00000003,

	EMPATHY_PARAMETER_ACCESS_FLAGS_ENUM_FORCE32 = 0x7FFFFFFF,
} Empathy_ParameterAccessFlags;

// Structs
typedef struct Empathy_InstanceDesc_t
{
	uint32_t reserved;
	// TODO: allocator context
	// TOOD: flags?
} Empathy_InstanceDesc;

typedef struct Empathy_Atom_t
{
	uint32_t type;
	uint32_t value;
} Empathy_Atom;

typedef struct Empathy_ValueType_t
{
	Empathy_ValueBaseType base_type;
	uint32_t atom_type;
} Empathy_ValueType;

typedef union Empathy_ValueData_t
{
	uint8_t u8;
	uint16_t u16;
	uint32_t u32;
	uint64_t u64;
	int8_t i8;
	int16_t i16;
	int32_t i32;
	int64_t i64;
	float f32;
	double f64;
	Empathy_Atom atom;
} Empathy_ValueData;

typedef struct Empathy_Value
{
	Empathy_ValueType type;
	Empathy_ValueData data;
} Empathy_Value;

typedef struct Empathy_AtomTypeDesc_t
{
	uint32_t type;
	uint32_t min_value;
	uint32_t max_value;
} Empathy_AtomTypeDesc;

typedef struct Empathy_ParameterDesc_t
{
	uint32_t table;

	Empathy_ValueType type;
	Empathy_ParameterAccessFlags access;

	uint64_t offset;
} Empathy_ParameterDesc;

typedef struct Empathy_YieldDesc
{
	uint64_t num_resume_values;
	const Empathy_ValueType *resume_value_types;
} Empathy_YieldDesc;

typedef struct Empathy_ProgramLayoutDesc_t
{
	uint64_t num_atom_types;
	const Empathy_AtomTypeDesc *atom_types;

	uint64_t num_parameters;
	const Empathy_ParameterDesc *parameters;

	uint64_t num_yields;
	const Empathy_YieldDesc *yields;
} Empathy_ProgramLayoutDesc;

typedef struct Empathy_ProgramDesc_t
{
	Empathy_ProgramLayout layout;
	uint64_t size;
	const void *data;
} Empathy_ProgramDesc;

typedef struct Empathy_MachineDesc_t
{
	uint64_t execution_stack_size;
	uint64_t predicate_stack_size;
	uint64_t max_parameter_tables;
	uint32_t instruction_limit;
} Empathy_MachineDesc;

// Function pointers
typedef Empathy_Result (*PFN_empathyCreateProgramLayout)(Empathy_Instance instance, const Empathy_ProgramLayoutDesc *desc, Empathy_ProgramLayout *layout);
typedef Empathy_Result (*PFN_empathyCreateProgram)(Empathy_Instance instance, const Empathy_ProgramDesc *desc, Empathy_Program *program);
typedef Empathy_Result (*PFN_empathyCreateMachine)(Empathy_Instance instance, const Empathy_MachineDesc *desc, Empathy_Machine *machine);

typedef Empathy_Result (*PFN_empathyDestroyProgramLayout)(Empathy_Instance instance, Empathy_ProgramLayout layout);
typedef Empathy_Result (*PFN_empathyDestroyProgram)(Empathy_Instance instance, Empathy_Program program);
typedef Empathy_Result (*PFN_empathyDestroyMachine)(Empathy_Instance instance, Empathy_Machine machine);
typedef Empathy_Result (*PFN_empathyDestroyInstance)(Empathy_Instance instance);

typedef Empathy_Result (*PFN_empathyBindProgram)(Empathy_Instance instance, Empathy_Machine machine, Empathy_Program program);
typedef Empathy_Result (*PFN_empathyBindParameterTable)(Empathy_Instance instance, Empathy_Machine machine, uint32_t index, uint64_t size, void *data);
typedef Empathy_Result (*PFN_empathyRun)(Empathy_Instance instance, Empathy_Machine machine);


typedef struct Empathy_InstanceTable_t
{
	PFN_empathyCreateProgramLayout createProgramLayout;
	PFN_empathyCreateProgram createProgram;
	PFN_empathyCreateMachine createMachine;

	PFN_empathyDestroyProgramLayout destroyProgramLayout;
	PFN_empathyDestroyProgram destroyProgram;
	PFN_empathyDestroyMachine destroyMachine;
	PFN_empathyDestroyInstance destroyInstance;

	PFN_empathyBindProgram bindProgram;
	PFN_empathyBindParameterTable bindParameterTable;
	PFN_empathyRun run;
} Empathy_InstanceTable;

// API
#if !defined(EMPATHY_NO_PROTOTYPES)
EMPATHY_APIENTRY Empathy_Result empathyCreateInstance(const Empathy_InstanceDesc *desc, Empathy_Instance* instance);
EMPATHY_APIENTRY Empathy_Result empathyGetInstanceTable(Empathy_Instance instance, Empathy_InstanceTable *instance_table);

EMPATHY_APIENTRY Empathy_Result empathyCreateProgramLayout(Empathy_Instance instance, const Empathy_ProgramLayoutDesc *desc, Empathy_ProgramLayout *layout);
EMPATHY_APIENTRY Empathy_Result empathyCreateProgram(Empathy_Instance instance, const Empathy_ProgramDesc *desc, Empathy_Program *program);
EMPATHY_APIENTRY Empathy_Result empathyCreateMachine(Empathy_Instance instance, const Empathy_MachineDesc *desc, Empathy_Machine *machine);

EMPATHY_APIENTRY Empathy_Result empathyDestroyProgramLayout(Empathy_Instance instance, Empathy_ProgramLayout layout);
EMPATHY_APIENTRY Empathy_Result empathyDestroyProgram(Empathy_Instance instance, Empathy_Program program);
EMPATHY_APIENTRY Empathy_Result empathyDestroyMachine(Empathy_Instance instance, Empathy_Machine machine);
EMPATHY_APIENTRY Empathy_Result empathyDestroyInstance(Empathy_Instance instance);

EMPATHY_APIENTRY Empathy_Result empathyBindProgram(Empathy_Instance instance, Empathy_Machine machine, Empathy_Program program);
EMPATHY_APIENTRY Empathy_Result empathyBindParameterTable(Empathy_Instance instance, Empathy_Machine machine, uint32_t index, uint64_t size, void *data);
EMPATHY_APIENTRY Empathy_Result empathyRun(Empathy_Instance instance, Empathy_Machine machine);
#endif

#ifdef __cplusplus
}
#endif
